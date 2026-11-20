// 正式版不弹出黑色的命令行窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    ingwork_lib::run()
}
