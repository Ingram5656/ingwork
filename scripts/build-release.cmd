@echo off
chcp 65001 >nul
rem 打包正式版，并去掉 exe 里带你 Windows 用户名的路径（C:\Users\你的名字\.cargo\...）
rem 用法：在项目根目录运行 scripts\build-release.cmd
rem 原理：编译时把 %USERPROFILE% 这段路径换成 ~。用户名只在这台电脑上展开，不会写进仓库。
rem 用 CARGO_ENCODED_RUSTFLAGS 而不是 RUSTFLAGS，是因为用户名里可能有空格。
cd /d "%~dp0.."
taskkill /IM ingwork.exe /F >nul 2>nul
set "CARGO_ENCODED_RUSTFLAGS=--remap-path-prefix=%USERPROFILE%=~"
call pnpm tauri build
if errorlevel 1 exit /b 1
echo.
findstr /m /i /c:"%USERPROFILE%" src-tauri\target\release\ingwork.exe >nul
if errorlevel 1 (
  echo [OK] exe 里没有你的用户目录路径。
) else (
  echo [!!] exe 里还有你的用户目录路径，先别发布。
)
