#!/usr/bin/env bash
# 个人部署修复：由 deploy/personal/pack.sh 打进部署包，并由 install.sh 在「启动应用容器」之前调用。
# 全部幂等，可重复执行。补的是官方 Docker 部署缺的两件事（时区与 compose 卷由 pack.sh 在 compose.yml 里处理）：
#   1. 官网线索入口：生产启动强制要求 /app/backend/.data/private 下有加密设置，官方 compose 既没挂持久卷也没配置步骤，
#      后端会反复崩溃（"Production website lead ingress must be enabled"）。
#   2. 内置管理员：后端每次迁移都会用源码里写死的固定密码播种 u_superadmin / superadmin@goodjob.com，
#      且先于 configure.sh 的首个管理员，导致你设置的邮箱和密码从不生效、公网存在已知密码的管理员。
#      这里把该行改写为 configure.sh 里设置的邮箱、姓名和密码（密码只在服务器内部从 secret 文件读取，不打印）。
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"
load_env

: "${GOODJOB_RELEASE_ID:?需由 install.sh 导出 GOODJOB_RELEASE_ID}"
BACKEND_IMAGE="$(image_repository backend):${GOODJOB_RELEASE_ID}"
PRIVATE_VOLUME="goodjobcrm_backend_private"
BUILT_IN_EMAIL="superadmin@goodjob.com"
BUILT_IN_ID="u_superadmin"

# ---------- 1. 官网线索入口设置 ----------
log "个人部署修复 1/2：官网线索入口设置（持久卷 $PRIVATE_VOLUME）"
docker volume create "$PRIVATE_VOLUME" >/dev/null
# 卷根目录默认属 root，而后端以 node(uid 1000) 运行。
docker run --rm --user root --entrypoint sh -v "$PRIVATE_VOLUME:/d" "$BACKEND_IMAGE" \
  -c 'chown 1000:1000 /d && chmod 700 /d'
if docker run --rm --entrypoint test -v "$PRIVATE_VOLUME:/app/backend/.data:ro" "$BACKEND_IMAGE" \
    -f /app/backend/.data/private/website-lead-ingress.enc.json; then
  log "官网线索入口设置已存在，跳过"
else
  ingress_secret="$(openssl rand -base64 64 | tr -d '\n')"
  # 密钥只经标准输入传入，不出现在命令行参数里；归属人用内置管理员（迁移后必然存在）。
  printf '{"schemaVersion":1,"enabled":true,"ownerId":"%s","current":{"id":"goodjob-website-v1","secret":"%s"},"previous":null}' \
    "$BUILT_IN_ID" "$ingress_secret" \
    | docker run --rm -i --entrypoint node -v "$PRIVATE_VOLUME:/app/backend/.data" "$BACKEND_IMAGE" \
        backend/dist/configure-website-lead-ingress.js >/dev/null
  unset ingress_secret
  log "已生成并加密写入官网线索入口设置"
fi

# ---------- 2. 内置管理员改写为 configure.sh 里设置的账号 ----------
log "个人部署修复 2/2：内置管理员改写为你设置的邮箱和密码"
admin_email="$(printf '%s' "${INITIAL_ADMIN_EMAIL:-}" | tr 'A-Z' 'a-z')"
admin_name="${INITIAL_ADMIN_NAME:-Super_Admin}"
password_file="$SECRETS_DIR/initial_admin_password"
[[ "$admin_email" =~ ^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,63}$ ]] || die "INITIAL_ADMIN_EMAIL 无效，无法改写内置管理员"
[[ "$admin_name" =~ ^[A-Za-z0-9._-]{1,80}$ ]] || die "INITIAL_ADMIN_NAME 无效，无法改写内置管理员"
[[ -s "$password_file" ]] || die "缺少 $password_file"

password_hash="$(docker run --rm --entrypoint node -v "$password_file:/p:ro" "$BACKEND_IMAGE" \
  --input-type=module -e 'import {readFileSync} from "node:fs"; import {hashPassword} from "/app/backend/dist/auth.js"; process.stdout.write(await hashPassword(readFileSync("/p","utf8")))')"
[[ -n "$password_hash" ]] || die "生成管理员密码哈希失败"

# 只改尚未改写的内置行（email 仍是固定值）：重复执行不会再次动它，也不会覆盖你日后在界面里改过的密码。
updated="$(printf "UPDATE users SET email='%s', name='%s', password_hash='%s', auth_version=auth_version+1 WHERE id='%s' AND email='%s';\nSELECT ROW_COUNT();\n" \
  "$admin_email" "$admin_name" "$password_hash" "$BUILT_IN_ID" "$BUILT_IN_EMAIL" \
  | compose exec -T mysql sh -ec 'MYSQL_PWD="$(cat /run/secrets/mysql_root_password)" exec mysql -u root -N -B "$MYSQL_DATABASE"' | tr -d '[:space:]')"
unset password_hash
if [[ "$updated" == "1" ]]; then
  log "内置管理员已改写为 $admin_email"
else
  log "内置管理员无需改写（已改写过，或库里没有该账号）"
fi

remaining="$(printf "SELECT COUNT(*) FROM users WHERE email='%s';\n" "$BUILT_IN_EMAIL" \
  | compose exec -T mysql sh -ec 'MYSQL_PWD="$(cat /run/secrets/mysql_root_password)" exec mysql -u root -N -B "$MYSQL_DATABASE"' | tr -d '[:space:]')"
if [[ "$remaining" != "0" ]]; then
  warn "库里仍存在固定密码的内置账号 $BUILT_IN_EMAIL，公网访问前请先处理"
fi
