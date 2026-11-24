@echo off
cd /d "%~dp0"
title 聚会游戏机

set "LOG=%~dp0启动日志.txt"
set "PORT=3210"

where node >nul 2>nul
if errorlevel 1 goto NONODE

echo.
echo   ============================================
echo     聚会游戏机
echo   ============================================
echo.

rem 端口占用检查
netstat -ano | findstr ":%PORT% " | findstr "LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo   [!] 端口 %PORT% 已经被占用。
  echo       如果你刚才已经启动过一次，不用再启动，直接打开：
  echo         http://localhost:%PORT%/host
  echo.
  echo       如果是别的东西占了这个端口，先把那个程序关掉。
  echo       按任意键仍然尝试重新启动，或直接关掉这个窗口。
  echo.
  pause >nul
  echo.
)

echo   正在启动，浏览器会自动打开主持台...
echo   这个窗口不要关，关掉就全场掉线。
echo.

start "" /b cmd /c "timeout /t 3 >nul & start http://localhost:%PORT%/host"

node server.js > "%LOG%" 2>&1
set "CODE=%ERRORLEVEL%"

echo.
echo   --------------------------------------------
echo   服务已退出，退出码：%CODE%
echo   日志已保存到：%LOG%
echo.
if not "%CODE%"=="0" (
  echo   如果刚才页面没能打开，常见原因是：
  echo     1. 端口 %PORT% 被占用，关掉旧窗口再试
  echo     2. 项目目录被移动，文件缺失
  echo     3. 杀毒软件拦截了 Node
  echo.
  echo   日志文件里有具体报错，可以直接打开看。
)
echo   --------------------------------------------
pause
goto END

:NONODE
echo.
echo   没有找到 Node.js。
echo.
echo   请去 https://nodejs.org 下载 LTS 版本安装，
echo   安装时保持默认选项（会自动加入 PATH），
echo   装完之后把这个窗口关掉，重新双击 start.bat。
echo.
pause
goto END

:END
