// 在哪个系统上。Windows 和 Mac 有几处习惯不一样：窗口按钮、托盘和菜单栏、快捷键的写法。

export const IS_MAC = /Mac/i.test(navigator.platform || navigator.userAgent);
