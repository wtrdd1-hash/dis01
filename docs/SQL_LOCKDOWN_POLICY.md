# 🛡️ SQL 백업 잠금 정책

> **모든 SQL 덤프, .sql 파일, 백업 폴더는 GitHub에 절대 올라가지 않습니다.**

## .gitignore 패턴

```gitignore
backups/
*.sql
*.sql.gz
*.dump
*.db
```

## 검증 방법

```bash
git status
git ls-files | grep -E "\.sql$|backups/" && echo LEAK! || echo OK
```

## 백업 규칙

1. **로컬 백업**: `\.bak\full_YYYYMMDD_HHMMSS\` (zip 압축, git 추적 안됨)
2. **VPS 백업**: 도커 mysql을 `/home/wtrdd/backups/` 에 6시간마다 dump (git 추적 안됨)
3. **원격 백업**: GitHub 등 외부에는 절대 push 하지 않음

## 만약 SQL 파일이 실수로 추적되면

```bash
git rm --cached path/to/leaked.sql
git commit -m "chore: remove leaked SQL dump"
git push origin main
```

## 안전장치: pre-commit hook

`.git/hooks/pre-commit` 파일에 다음 코드를 추가하면 SQL 파일이 stage될 때 차단합니다:

```bash
#!/bin/bash
git diff --cached --name-only | grep -E "\.sql$|backups/" | while read f; do
  echo "🚨 BLOCKED: SQL dump detected in $f"
  exit 1
done
```

## 왜 SQL은 안 올라가는가?

- 디스코드 ID, IP, 사용자 데이터가 들어있음 → **개인정보보호법 위반 위험**
- GitHub public repo면 즉시 노출
- 서버에서 직접 dump하여 안전하게 보관

**모든 SQL 백업은 git 추적에서 영구 제외합니다.**
