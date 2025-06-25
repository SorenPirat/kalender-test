@echo off
:: Start din Supabase-loginserver

:: Gå til den rigtige mappe
cd /d E:\Dokumenter\NKL\Hjemmeside\Nøglekalender\loginsystem

:: Start http-server på port 8080
echo Starter lokal server paa http://localhost:8080/login.html
http-server .

:: Pause så vinduet ikke lukker med det samme ved fejl
pause
