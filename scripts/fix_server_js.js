const fs = require('fs');
const path = require('path');

const serverFile = path.join(__dirname, '../src/web/server.js');
let content = fs.readFileSync(serverFile, 'utf8');

// app.get('/auth/discord' 이전의 레거시 코드 제거
const searchKey = "  // Discord OAuth2 시작 (state CSRF 방지)";
const targetIdx = content.indexOf(searchKey);
if (targetIdx === -1) {
  console.error('searchKey not found');
  process.exit(1);
}

// app.get('/admin/logs' 블록의 닫는 괄호 찾기
const logsRouteKey = "app.get('/admin/logs', requireAdminWeb, async (req, res) => {";
const logsIdx = content.indexOf(logsRouteKey);
if (logsIdx === -1) {
  console.error('logsRouteKey not found');
  process.exit(1);
}

// logsIdx 이후의 "res.render('admin/logs'" 찾기
const renderKey = "res.render('admin/logs', {";
const renderIdx = content.indexOf(renderKey, logsIdx);
if (renderIdx === -1) {
  console.error('renderKey not found');
  process.exit(1);
}

// 그 다음 "  });" 찾기
const endLogsRouteKey = "  });";
const endLogsIdx = content.indexOf(endLogsRouteKey, renderIdx);
if (endLogsIdx === -1) {
  console.error('endLogsRouteKey not found');
  process.exit(1);
}

const before = content.slice(0, endLogsIdx + endLogsRouteKey.length);
const after = content.slice(targetIdx);

const newContent = before + '\n\n' + after;
fs.writeFileSync(serverFile, newContent, 'utf8');
console.log('✅ server.js 레거시 코드 정상 제거 완료!');
