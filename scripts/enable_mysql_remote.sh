#!/usr/bin/env bash
# 원격 MySQL 공개는 기본적으로 금지한다. 이 프로젝트의 앱은 로컬 DB만 사용한다.
set -euo pipefail

echo '원격 MySQL 공개 스크립트는 보안상 비활성화되었습니다.' >&2
echo '필요한 경우 허용 IP·최소 권한·자격증명 회전 계획을 검토한 뒤 별도 운영 절차로 진행하세요.' >&2
exit 1
