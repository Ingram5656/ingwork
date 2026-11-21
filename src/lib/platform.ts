// 在哪个系统上。Windows 和 Mac 有几处习惯不一样：窗口按钮、托盘和菜单栏、快捷键的写法。

export const IS_MAC = /Mac/i.test(navigator.platform || navigator.userAgent);

/**
 * 这次按键是在给输入法上屏（比如拼音打到一半按回车把字母送上去），不是真的按了回车。
 * 有回车提交的输入框都要先问一下，不然会把半截拼音当成内容提交出去。
 * Mac 的网页引擎有个老问题：上屏那一下有时已经报"不在输入状态"了，只能再看按键码是不是 229
 */
export function imeBusy(event: { nativeEvent: KeyboardEvent }): boolean {
  return event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;
}
