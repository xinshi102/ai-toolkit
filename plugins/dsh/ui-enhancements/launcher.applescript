on run
	set urlStr to "http://127.0.0.1:3080/"
	set serverUp to false
	try
		do shell script "curl -sf -o /dev/null " & quoted form of urlStr
		set serverUp to true
	end try
	if not serverUp then
		do shell script "cd /Users/xinshi && nohup node /Users/xinshi/.hermes/node/bin/dsh web >/tmp/dsh-web.log 2>&1 &"
		repeat 25 times
			delay 1
			try
				do shell script "curl -sf -o /dev/null " & quoted form of urlStr
				exit repeat
			end try
		end repeat
	end if
	do shell script "open -a 'Google Chrome' --args --app=" & quoted form of urlStr
end run
