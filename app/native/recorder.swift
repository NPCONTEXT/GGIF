// GIF 工具的录屏小助手：苹果录屏接口（ScreenCaptureKit）+ 系统选择窗口（SCContentSharingPicker，不用「屏幕录制」权限）。
// 作者选「苹果接口（推荐）」；不录鼠标（作者：「我们99%的录制都用不到」）。设计看 GIF工具/录屏/方案.md §八。
//
// 由主进程（Electron）启动，常驻；标准输入一行一个 JSON 命令，标准输出一行一个 JSON 事件，日志写标准错误。
//   {"cmd":"pick"}                         弹系统选择窗口（屏幕或单个窗口）→ picked / pick-cancelled
//   {"cmd":"start","dir":…,"rect":{x,y,w,h}|null,"fps":60,"maxWidth":1920,"codec":"h264","segment":0.5,"cursor":false}
//                                           按选好的内容开录；rect 是屏幕里的一块（点，相对这块屏幕左上角），只对选屏幕有效
//                                           → started（第一帧到了）、segment（每写完一块）、stats（每秒）
//   {"cmd":"mark"}                         记一个时刻（和画面用同一个系统时钟）→ mark {t: 开录后第几秒}
//   {"cmd":"stop"}                         停录，补最后一帧到停的时刻，写完最后一块 → stopped
//   {"cmd":"quit"}                         退出
// 画面按约 0.5 秒一块写成分段 MP4（init.mp4 + seg_00001.m4s …），每块以关键帧开头；主进程按块拼成片段，不用重新编码。
import AppKit
import AVFoundation
import CoreMedia
import Foundation
import ScreenCaptureKit
import UniformTypeIdentifiers

// MARK: - 按文件编号找路径（菜单栏图片列表用，10-20 凌晨加）
// gifkit-recorder locate 设备号:编号 …  → 每个一行，打印这个文件现在在哪（找不到打印空行），打印完就退出，不起录屏。
// 同一块硬盘上改名、挪到别的文件夹，文件编号不变：打开 /.vol/设备号/编号，再用 fcntl(F_GETPATH) 问现在的路径（10-20 实测可行）。
if CommandLine.arguments.count > 1 && CommandLine.arguments[1] == "locate" {
  for arg in CommandLine.arguments.dropFirst(2) {
    let parts = arg.split(separator: ":")
    var found = ""
    if parts.count == 2, let dev = UInt64(parts[0]), let ino = UInt64(parts[1]) {
      let fd = open("/.vol/\(dev)/\(ino)", O_RDONLY)
      if fd >= 0 {
        var buf = [CChar](repeating: 0, count: Int(MAXPATHLEN))
        if fcntl(fd, F_GETPATH, &buf) != -1 { found = String(cString: buf) }
        close(fd)
      }
    }
    print(found)
  }
  exit(0)
}

// MARK: - 输出（多个线程都会写，排队）

let outQueue = DispatchQueue(label: "gifkit.recorder.out")
func emit(_ obj: [String: Any]) {
  outQueue.async {
    guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]) else { return }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0A]))
  }
}
func log(_ s: String) {
  FileHandle.standardError.write(("[录屏助手] " + s + "\n").data(using: .utf8)!)
}
func hostNow() -> CMTime { CMClockGetTime(CMClockGetHostTimeClock()) }
func rectJSON(_ r: CGRect) -> [String: Double] {
  ["x": Double(r.origin.x), "y": Double(r.origin.y), "w": Double(r.size.width), "h": Double(r.size.height)]
}

// MARK: - 选择窗口

final class PickerHub: NSObject, SCContentSharingPickerObserver {
  var filter: SCContentFilter?

  func present() {
    let picker = SCContentSharingPicker.shared
    var cfg = SCContentSharingPickerConfiguration()
    cfg.allowedPickerModes = [.singleDisplay, .singleWindow]
    if let me = Bundle.main.bundleIdentifier { cfg.excludedBundleIDs = [me] }
    picker.defaultConfiguration = cfg
    picker.add(self)
    picker.isActive = true
    picker.present()
  }

  func contentSharingPicker(_ picker: SCContentSharingPicker, didCancelFor stream: SCStream?) {
    emit(["ev": "pick-cancelled"])
  }

  func contentSharingPicker(_ picker: SCContentSharingPicker, didUpdateWith filter: SCContentFilter, for stream: SCStream?) {
    self.filter = filter
    var ev: [String: Any] = [
      "ev": "picked",
      "kind": filter.style == .window ? "window" : filter.style == .display ? "display" : "other",
      "scale": Double(filter.pointPixelScale),
      "contentRect": rectJSON(filter.contentRect),
    ]
    if #available(macOS 15.2, *) {
      if let d = filter.includedDisplays.first {
        ev["displayID"] = Int(d.displayID)
        ev["displayFrame"] = rectJSON(d.frame)
      }
      if let w = filter.includedWindows.first {
        ev["windowID"] = Int(w.windowID)
        ev["windowFrame"] = rectJSON(w.frame)
        ev["title"] = w.title ?? ""
        ev["app"] = w.owningApplication?.applicationName ?? ""
      }
    }
    emit(ev)
  }

  func contentSharingPickerStartDidFailWithError(_ error: any Error) {
    emit(["ev": "error", "where": "pick", "msg": String(describing: error)])
  }
}

// MARK: - 录制

final class Recorder: NSObject, SCStreamOutput, SCStreamDelegate, AVAssetWriterDelegate {
  let dir: URL
  let fps: Int
  let segmentSec: Double
  var stream: SCStream?
  var writer: AVAssetWriter?
  var input: AVAssetWriterInput?
  var adaptor: AVAssetWriterInputPixelBufferAdaptor?
  let q = DispatchQueue(label: "gifkit.recorder.frames")
  var firstPTS: CMTime?
  var lastPTS: CMTime?
  var lastBuffer: CVPixelBuffer?
  var frames = 0
  var dropped = 0
  var segIndex = 0
  var stopping = false
  var statsTimer: DispatchSourceTimer?
  var outW = 0
  var outH = 0
  var codec: AVVideoCodecType = .h264

  init(dir: URL, fps: Int, segmentSec: Double) {
    self.dir = dir
    self.fps = fps
    self.segmentSec = segmentSec
  }

  /** 按选好的内容配置并开录。rect：屏幕里的一块（点）。 */
  func start(filter: SCContentFilter, rect: CGRect?, maxWidth: Int, cursor: Bool, codecName: String) async throws {
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let scale = CGFloat(filter.pointPixelScale)
    let cfg = SCStreamConfiguration()
    var srcPt = filter.contentRect.size
    if let r = rect, filter.style == .display {
      cfg.sourceRect = r
      srcPt = r.size
    }
    // 输出宽度：按 Retina 原像素，但不超过 maxWidth（公众号 GIF 最宽 1080，录太大只是白占硬盘和编码器）
    var w = Double(srcPt.width * scale)
    var h = Double(srcPt.height * scale)
    if w > Double(maxWidth) {
      h = h * Double(maxWidth) / w
      w = Double(maxWidth)
    }
    outW = max(2, Int(w) / 2 * 2)
    outH = max(2, Int(h.rounded()) / 2 * 2)
    cfg.width = outW
    cfg.height = outH
    cfg.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
    cfg.showsCursor = cursor
    cfg.pixelFormat = kCVPixelFormatType_32BGRA
    cfg.colorSpaceName = CGColorSpace.sRGB // 直接录成 sRGB，引擎不用再从 Display P3 转色
    cfg.queueDepth = 6
    cfg.capturesAudio = false
    cfg.ignoreShadowsSingleWindow = true
    codec = codecName == "hevc" ? .hevc : .h264

    let s = SCStream(filter: filter, configuration: cfg, delegate: self)
    try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: q)
    stream = s
    try await s.startCapture()
    emit(["ev": "capturing", "width": outW, "height": outH, "fps": fps, "scale": Double(scale), "sourcePt": ["w": Double(srcPt.width), "h": Double(srcPt.height)]])
    statsTimer = DispatchSource.makeTimerSource(queue: q)
    statsTimer?.schedule(deadline: .now() + 1, repeating: 1)
    statsTimer?.setEventHandler { [weak self] in
      guard let self, let f = self.firstPTS, let l = self.lastPTS else { return }
      emit(["ev": "stats", "frames": self.frames, "dropped": self.dropped, "seconds": CMTimeGetSeconds(CMTimeSubtract(l, f))])
    }
    statsTimer?.resume()
  }

  private func makeWriter(at pts: CMTime) throws {
    let wr = AVAssetWriter(contentType: UTType(AVFileType.mp4.rawValue)!)
    wr.outputFileTypeProfile = .mpeg4AppleHLS
    wr.preferredOutputSegmentInterval = CMTime(seconds: segmentSec, preferredTimescale: 600)
    wr.initialSegmentStartTime = pts
    wr.delegate = self
    // 码率：每像素每帧约 0.15 比特，8–40 Mbps；关键帧最长 0.5 秒一个，好按块拼片段
    let bitrate = min(40_000_000, max(8_000_000, Int(Double(outW * outH * fps) * 0.15)))
    let settings: [String: Any] = [
      AVVideoCodecKey: codec,
      AVVideoWidthKey: outW,
      AVVideoHeightKey: outH,
      AVVideoColorPropertiesKey: [
        AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
        AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
        AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
      ],
      AVVideoCompressionPropertiesKey: [
        AVVideoAverageBitRateKey: bitrate,
        AVVideoExpectedSourceFrameRateKey: fps,
        AVVideoMaxKeyFrameIntervalDurationKey: segmentSec,
        AVVideoAllowFrameReorderingKey: false,
      ],
    ]
    let inp = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
    inp.expectsMediaDataInRealTime = true
    let ad = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: inp, sourcePixelBufferAttributes: nil)
    guard wr.canAdd(inp) else { throw NSError(domain: "gifkit", code: 1, userInfo: [NSLocalizedDescriptionKey: "编码器不接受这个设置"]) }
    wr.add(inp)
    guard wr.startWriting() else { throw wr.error ?? NSError(domain: "gifkit", code: 2) }
    wr.startSession(atSourceTime: pts)
    writer = wr
    input = inp
    adaptor = ad
    emit(["ev": "writer", "bitrate": bitrate, "codec": codec == .hevc ? "hevc" : "h264"])
  }

  // 画面
  func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .screen, !stopping, sb.isValid else { return }
    guard let att = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
          let raw = att.first?[.status] as? Int, let status = SCFrameStatus(rawValue: raw), status == .complete,
          let pb = CMSampleBufferGetImageBuffer(sb) else { return }
    let pts = CMSampleBufferGetPresentationTimeStamp(sb)
    if writer == nil {
      do {
        try makeWriter(at: pts)
      } catch {
        emit(["ev": "error", "where": "writer", "msg": String(describing: error)])
        return
      }
      firstPTS = pts
      emit(["ev": "started", "host": CMTimeGetSeconds(pts)])
    }
    guard let inp = input, let ad = adaptor else { return }
    if !inp.isReadyForMoreMediaData {
      dropped += 1
      return
    }
    if ad.append(pb, withPresentationTime: pts) {
      frames += 1
      lastPTS = pts
      lastBuffer = pb
    } else {
      dropped += 1
      if let e = writer?.error { emit(["ev": "error", "where": "append", "msg": String(describing: e)]) }
    }
  }

  func stream(_ stream: SCStream, didStopWithError error: any Error) {
    emit(["ev": "error", "where": "stream", "msg": String(describing: error)])
    stop()
  }

  // 每写完一块：init.mp4 或 seg_00001.m4s，报出这一块从第几秒开始、多长
  func assetWriter(_ writer: AVAssetWriter, didOutputSegmentData data: Data, segmentType: AVAssetSegmentType, segmentReport: AVAssetSegmentReport?) {
    let name: String
    if segmentType == .initialization {
      name = "init.mp4"
    } else {
      segIndex += 1
      name = String(format: "seg_%05d.m4s", segIndex)
    }
    let url = dir.appendingPathComponent(name)
    do {
      try data.write(to: url)
    } catch {
      emit(["ev": "error", "where": "segment", "msg": String(describing: error)])
      return
    }
    var ev: [String: Any] = ["ev": "segment", "file": name, "bytes": data.count, "type": segmentType == .initialization ? "init" : "media"]
    if segmentType != .initialization, let tr = segmentReport?.trackReports.first, let f = firstPTS {
      ev["start"] = CMTimeGetSeconds(CMTimeSubtract(tr.earliestPresentationTimeStamp, f))
      ev["dur"] = CMTimeGetSeconds(tr.duration)
      ev["index"] = segIndex
    }
    emit(ev)
  }

  /** 停：先停抓屏，再把最后一帧补到停的时刻（画面不动时接口不出新帧，不补的话片段会短一截），写完收尾。 */
  func stop() {
    q.async { [self] in
      if stopping { return }
      stopping = true
      statsTimer?.cancel()
      let stopAt = hostNow()
      Task {
        try? await stream?.stopCapture()
        q.async { [self] in
          guard let wr = writer, let inp = input, let ad = adaptor else {
            emit(["ev": "stopped", "frames": 0, "seconds": 0])
            return
          }
          if let pb = lastBuffer, let l = lastPTS, CMTimeCompare(stopAt, l) > 0, inp.isReadyForMoreMediaData {
            ad.append(pb, withPresentationTime: stopAt)
            lastPTS = stopAt
          }
          inp.markAsFinished()
          let secs = firstPTS.map { CMTimeGetSeconds(CMTimeSubtract(lastPTS ?? $0, $0)) } ?? 0
          wr.finishWriting { [self] in
            emit(["ev": "stopped", "frames": frames, "dropped": dropped, "seconds": secs, "segments": segIndex,
                  "status": wr.status == .completed ? "ok" : "failed", "error": wr.error.map { String(describing: $0) } ?? ""])
          }
        }
      }
    }
  }

  /** 打标：和画面同一个系统时钟，返回开录后第几秒（还没出第一帧就是 null）。 */
  func markTime() -> Double? {
    guard let f = firstPTS else { return nil }
    return CMTimeGetSeconds(CMTimeSubtract(hostNow(), f))
  }
}

// MARK: - 命令

let hub = PickerHub()
var recorder: Recorder?

func handle(_ line: String) {
  guard let data = line.data(using: .utf8),
        let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let cmd = obj["cmd"] as? String else {
    emit(["ev": "error", "where": "cmd", "msg": "看不懂的命令：\(line.prefix(200))"])
    return
  }
  switch cmd {
  case "pick":
    DispatchQueue.main.async { hub.present() }
  case "start":
    guard let filter = hub.filter else {
      emit(["ev": "error", "where": "start", "msg": "还没选要录的屏幕或窗口"])
      return
    }
    guard recorder == nil else {
      emit(["ev": "error", "where": "start", "msg": "已经在录了"])
      return
    }
    let dir = URL(fileURLWithPath: obj["dir"] as? String ?? NSTemporaryDirectory())
    var rect: CGRect? = nil
    if let r = obj["rect"] as? [String: Any], let x = r["x"] as? Double, let y = r["y"] as? Double, let w = r["w"] as? Double, let h = r["h"] as? Double {
      rect = CGRect(x: x, y: y, width: w, height: h)
    }
    let rec = Recorder(dir: dir, fps: obj["fps"] as? Int ?? 60, segmentSec: obj["segment"] as? Double ?? 0.5)
    recorder = rec
    Task {
      do {
        try await rec.start(filter: filter, rect: rect, maxWidth: obj["maxWidth"] as? Int ?? 1920,
                            cursor: obj["cursor"] as? Bool ?? false, codecName: obj["codec"] as? String ?? "h264")
        if recorder !== rec { rec.stop() } // 开始的路上已经被叫停了：开起来就马上停，不留一个没人管的录制
      } catch {
        emit(["ev": "error", "where": "start", "msg": String(describing: error)])
        recorder = nil
      }
    }
  case "mark":
    let t = recorder?.markTime()
    emit(["ev": "mark", "t": t.map { $0 as Any } ?? NSNull(), "host": CMTimeGetSeconds(hostNow())])
  case "stop":
    guard let rec = recorder else {
      emit(["ev": "stopped", "frames": 0, "seconds": 0])
      return
    }
    recorder = nil
    rec.stop()
  case "quit":
    outQueue.sync {}
    exit(0)
  default:
    emit(["ev": "error", "where": "cmd", "msg": "不认识的命令：\(cmd)"])
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory) // 不出程序坞图标、不抢菜单栏
emit(["ev": "ready", "os": ProcessInfo.processInfo.operatingSystemVersionString])

// 标准输入在后台线程按行读；读到头（主进程退出）就退出
Thread.detachNewThread {
  while let line = readLine(strippingNewline: true) {
    let s = line.trimmingCharacters(in: .whitespaces)
    if !s.isEmpty { handle(s) }
  }
  outQueue.sync {}
  exit(0)
}
app.run()
