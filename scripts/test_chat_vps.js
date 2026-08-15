const http = require('http');

const data = JSON.stringify({ message: '💬 실시간 웹소켓 광장 채팅 테스트 정상 가동 중!' });

const req = http.request({
  hostname: '127.0.0.1',
  port: 8080,
  path: '/api/chat/send',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
    'Cookie': 'discord_user=' + encodeURIComponent(JSON.stringify({ id: '889085646768078850', username: '월덕관리자' }))
  }
}, (res) => {
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => {
    console.log('STATUS:', res.statusCode);
    console.log('BODY:', body);
  });
});

req.on('error', (e) => console.error('ERROR:', e));
req.write(data);
req.end();
