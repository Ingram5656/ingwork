fn main() {
    // 环境音文件夹里加了、换了文件时重新编译，新的声音才会进到软件里
    println!("cargo:rerun-if-changed=sounds/ambient");
    tauri_build::build()
}
