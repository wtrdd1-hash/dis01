const http = require('http');

const data = JSON.stringify({ type: 'power' });

const req = http.request({
  hostname: '127.0.0.1',
  port: 8080,
  path: '/api/clicker/upgrade',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
    'Cookie': 'discord_user=' + encodeURIComponent(JSON.stringify({ id: '889085646768078850', username: '월덕' }))
  }
}, (res) => {
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => {
    console.log('UPGRADE STATUS:', res.statusCode);
    console.log('UPGRADE BODY:', body);
  });
});

req.on('error', (e) => console.error('ERROR:', e));
req.write(data);
req.end();
