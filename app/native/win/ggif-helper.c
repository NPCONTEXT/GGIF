// GGIF 的 Windows 小助手（Windows版 11-08）。Mac 上的 Swift 小助手（native/recorder.swift）管录屏和按编号找文件；Windows 一期用它做两件事：
//
//   ggif-helper.exe watch <父进程号>（W11e，GGIF 现在用这个）
//     ① 每秒问一次系统「前台是不是全屏程序、演示模式」（SHQueryUserNotificationState），变了才写一行 {"fullscreen":true|false}；
//     ② 拖文件到托盘的 GGIF 图标上（作者：「改成拖到托盘弹面板」，像聊天软件的做法）：Windows 不会告诉托盘图标「有东西拖过来」，
//        所以每 0.05 秒看一眼左键和光标——在图标外面按下左键、拖进图标范围，写 {"tray":"enter"}；拖出去写 {"tray":"leave"}；
//        进过图标后松手写 {"tray":"up"}。在图标上按下（就是点它）不报。图标范围由 GGIF 从标准输入发来：「rect x y 宽 高」（实际像素）。
//     父进程（GGIF）退出就跟着退，不留孤儿进程。
//
//   ggif-helper.exe fullscreen-watch <父进程号>（老写法，只报全屏，留着给测试和旧版用）
//
// 编（云端 .github/workflows/windows.yml 用 MSVC 编，开发机 Mac 上没有）：
//   cl /nologo /O2 /W3 /utf-8 ggif-helper.c /Fe:ggif-helper.exe
#define _WIN32_WINNT 0x0A00
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shellapi.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#pragma comment(lib, "user32.lib")
#pragma comment(lib, "shell32.lib")

static int full_now(void) {
  QUERY_USER_NOTIFICATION_STATE s;
  if (FAILED(SHQueryUserNotificationState(&s))) return 0;
  return s == QUNS_BUSY || s == QUNS_RUNNING_D3D_FULL_SCREEN || s == QUNS_PRESENTATION_MODE;
}

/** 写一行；管道断了（GGIF 不要了）返回 0 */
static int emit(const char *json) {
  return printf("%s\n", json) >= 0 && fflush(stdout) == 0;
}

// 托盘图标的范围（实际像素）：读标准输入的线程写，主循环读；先把宽清零再写别的，读到一半的新旧值顶多让这一次判断落空
static volatile LONG g_x = 0, g_y = 0, g_w = 0, g_h = 0;

static DWORD WINAPI read_stdin(LPVOID unused) {
  char line[256];
  (void)unused;
  while (fgets(line, sizeof line, stdin)) {
    long x, y, w, h;
    if (sscanf(line, "rect %ld %ld %ld %ld", &x, &y, &w, &h) == 4) {
      InterlockedExchange(&g_w, 0);
      InterlockedExchange(&g_x, x);
      InterlockedExchange(&g_y, y);
      InterlockedExchange(&g_h, h);
      InterlockedExchange(&g_w, w);
    }
  }
  return 0;
}

static int watch(DWORD ppid, int with_tray) {
  HANDLE parent = OpenProcess(SYNCHRONIZE, FALSE, ppid);
  if (!parent) return 3; // 父进程已经不在了（或者号不对）
  if (with_tray) {
    // 光标坐标要实际像素，和 GGIF 换算好的图标范围对得上（Windows 10 1703 起有；没有就照旧，缩放 100% 时也对）
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    CreateThread(NULL, 0, read_stdin, NULL, 0, NULL);
  }
  int last_full = -1, tick = 0, was_down = 0, candidate = 0, inside_now = 0, entered = 0;
  for (;;) {
    if (tick++ % (with_tray ? 20 : 1) == 0) {
      int f = full_now();
      if (f != last_full) {
        if (!emit(f ? "{\"fullscreen\":true}" : "{\"fullscreen\":false}")) return 0;
        last_full = f;
      }
    }
    if (with_tray) {
      int vk = GetSystemMetrics(SM_SWAPBUTTON) ? VK_RBUTTON : VK_LBUTTON; // 左右键对调过的，主键是右键
      int down = (GetAsyncKeyState(vk) & 0x8000) != 0;
      POINT p;
      GetCursorPos(&p);
      LONG w = g_w, h = g_h, x = g_x, y = g_y;
      int inside = w > 0 && h > 0 && p.x >= x && p.x < x + w && p.y >= y && p.y < y + h;
      if (down && !was_down) candidate = !inside; // 在图标外面按下的才可能是拖过来的；在图标上按下是点它
      if (down && candidate) {
        if (inside && !inside_now) {
          if (!emit("{\"tray\":\"enter\"}")) return 0;
          inside_now = 1;
          entered = 1;
        } else if (!inside && inside_now) {
          if (!emit("{\"tray\":\"leave\"}")) return 0;
          inside_now = 0;
        }
      }
      if (!down && was_down) {
        if (entered && !emit("{\"tray\":\"up\"}")) return 0;
        candidate = inside_now = entered = 0;
      }
      was_down = down;
    }
    if (WaitForSingleObject(parent, with_tray ? 50 : 1000) == WAIT_OBJECT_0) return 0; // 父进程退了
  }
}

int main(int argc, char **argv) {
  if (argc >= 3 && strcmp(argv[1], "watch") == 0) return watch((DWORD)strtoul(argv[2], NULL, 10), 1);
  if (argc >= 3 && strcmp(argv[1], "fullscreen-watch") == 0) return watch((DWORD)strtoul(argv[2], NULL, 10), 0);
  fprintf(stderr, "usage: ggif-helper.exe watch <parent pid> | fullscreen-watch <parent pid>\n");
  return 2;
}
