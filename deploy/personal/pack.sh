#!/usr/bin/env bash
# 个人部署包打包脚本（本地构建镜像模式）。用法：deploy/personal/pack.sh <输出目录>
#
# 为什么不用官方 deploy/docker-compose/build-package.sh：它引用了仓库里不存在的
# publish-images.sh / update-registry.sh / baota-update.sh，且漏带 Dockerfile.backend 需要的 deploy/fontconfig。
# 本脚本只改「包内副本」，不改仓库里的官方文件，所以合并上游时不会冲突。
#
# 前提：backend / frontend / whatsapp-plugin / integration-sdk 的 dist 已构建并通过测试。
# 不包含任何 .env / secret。
#
# 对包内副本的调整（每处都有断言，补丁没生效会直接失败）：
#   1) baota-update.sh 占位（官方仓库缺此文件，install.sh 末尾会 install 它）。
#   2) configure.sh：默认改为 GOODJOB_IMAGE_MODE=local，并删掉作者 ACR 镜像地址（那里面没有我们的代码）。
#   3) install.sh：预置 50 个 beta 管理员改为需显式开启；启动应用前调用 personal-fixups.sh。
#   4) compose.yml：时区统一（官方只给 mysql 设了 Asia/Shanghai，后端/通信容器是 UTC，导致 expires_at>NOW() 之类
#      判断全部错位，Runner 配对码永远"已过期"）；给后端挂 /app/backend/.data 持久卷（官网线索入口设置）。
#
# 环境变量：GOODJOB_TZ 覆盖容器时区，默认 America/Los_Angeles。
set -Eeuo pipefail
umask 027

P="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT=${1:?用法：pack.sh <输出目录>}
export GOODJOB_TZ="${GOODJOB_TZ:-America/Los_Angeles}"
[[ "$GOODJOB_TZ" =~ ^[A-Za-z0-9_+/-]+$ ]] || { echo "GOODJOB_TZ 无效：$GOODJOB_TZ" >&2; exit 1; }
TS=$(date +%Y%m%d-%H%M%S)
COMMIT=$(git -C "$P" rev-parse --short HEAD)
VER=$(node -p 'require(process.argv[1]).version' "$P/frontend/public/product-config.json")
RELEASE="${VER}-${COMMIT}-${TS}"
NAME="GoodJob-CRM-Docker-$TS"
STG="$OUT/stage/$NAME"
rm -rf "$OUT/stage" && mkdir -p "$STG"

for f in backend/dist/server.js backend/dist/migrate-mysql.js frontend/dist/index.html \
         whatsapp-plugin/dist/index.html whatsapp-plugin/dist-server/server/index.js \
         whatsapp-plugin/dist-server/server/scripts/migrate.js integration-sdk/dist/index.js; do
  [[ -f "$P/$f" ]] || { echo "缺少构建产物：$f" >&2; exit 1; }
done

cd "$P"
mkdir -p "$STG"/{backend,frontend,whatsapp-plugin,integration-sdk,integration-worker,deploy}
cp package.json package-lock.json "$STG/"
for w in backend frontend integration-sdk integration-worker; do cp "$w/package.json" "$STG/$w/"; done
cp whatsapp-plugin/package.json whatsapp-plugin/package-lock.json "$STG/whatsapp-plugin/"
rsync -a backend/dist/ "$STG/backend/dist/"
rsync -a backend/resources/ "$STG/backend/resources/"
rsync -a integration-sdk/dist/ "$STG/integration-sdk/dist/"
rsync -a frontend/dist/ "$STG/frontend/dist/"
rsync -a whatsapp-plugin/dist/ "$STG/whatsapp-plugin/dist/"
rsync -a whatsapp-plugin/dist-server/ "$STG/whatsapp-plugin/dist-server/"
rsync -a agent-knowledge/ "$STG/agent-knowledge/"
rsync -a agent-skills/ "$STG/agent-skills/"
rsync -a deploy/docker-compose/ "$STG/deploy/docker-compose/"
rsync -a deploy/fontconfig/ "$STG/deploy/fontconfig/"
cp LICENSE NOTICE README.md .dockerignore "$STG/"
printf '%s\n' "$RELEASE" > "$STG/RELEASE-ID"

# ---- 对部署脚本的定向调整（只改包内副本，不动仓库） ----
D="$STG/deploy/docker-compose"

# 1) 官方仓库缺 baota-update.sh，install.sh 末尾会 install 它：放一个占位。
cat > "$D/baota-update.sh" <<'EOF'
#!/usr/bin/env bash
echo "此部署未包含宝塔一键更新入口；升级请重新上传部署包并执行 ./install.sh" >&2
exit 1
EOF
chmod 0755 "$D/baota-update.sh"

# 2) configure.sh 默认写 registry 模式（拉作者的 ACR 镜像，里面没有我们的代码）：改为本地构建。
sed -i.bak \
  -e 's/^GOODJOB_IMAGE_MODE=registry$/GOODJOB_IMAGE_MODE=local/' \
  -e '/^GOODJOB_BACKEND_IMAGE=crpi-/d' \
  -e '/^GOODJOB_GATEWAY_IMAGE=crpi-/d' \
  -e '/^GOODJOB_COMMUNICATION_IMAGE=crpi-/d' \
  "$D/configure.sh"
rm -f "$D/configure.sh.bak"
grep -q '^GOODJOB_IMAGE_MODE=local$' "$D/configure.sh" || { echo "configure.sh 补丁未生效（local 模式）" >&2; exit 1; }
if grep -q 'crpi-' "$D/configure.sh"; then echo "configure.sh 仍含作者 ACR 镜像地址" >&2; exit 1; fi

# 3) install.sh：预置 50 个 beta 管理员默认不执行；启动应用容器前执行个人部署修复。
perl -0pi -e 's#(log "预置 50 个团队管理员[^\n]*\n)(compose --profile tools run --rm backend-migrate node backend/dist/provision-beta-admins\.js\n)#if [[ "\${GOODJOB_PROVISION_BETA_ADMINS:-false}" == "true" ]]; then\n  \1  \2fi\n#' "$D/install.sh"
grep -q 'GOODJOB_PROVISION_BETA_ADMINS' "$D/install.sh" || { echo "install.sh 补丁未生效（beta 管理员）" >&2; exit 1; }
perl -0pi -e 's#(log "启动应用容器"\n)#log "执行个人部署修复（官网线索入口、内置管理员）"\n"\$SCRIPT_DIR/personal-fixups.sh"\n\n$1#' "$D/install.sh"
grep -q 'personal-fixups.sh' "$D/install.sh" || { echo "install.sh 补丁未生效（personal-fixups）" >&2; exit 1; }
cp "$P/deploy/personal/personal-fixups.sh" "$D/personal-fixups.sh"

# 4) compose.yml：统一时区 + 后端持久卷。
perl -0pi -e '
  s/TZ: Asia\/Shanghai/TZ: $ENV{GOODJOB_TZ}/g;
  s/(    environment: &(?:backend|communication)_environment\n      NODE_ENV: production\n)/$1      TZ: $ENV{GOODJOB_TZ}\n/g;
  s/(    secrets: \*backend_secrets\n    networks:\n      - private\n    volumes:\n      - uploads_data:\/app\/uploads\n)/$1      - backend_private:\/app\/backend\/.data\n/;
  s/(  uploads_data:\n    name: goodjobcrm_uploads_data\n)/$1  backend_private:\n    name: goodjobcrm_backend_private\n/;
' "$D/compose.yml"
tz_count=$(grep -c "TZ: $GOODJOB_TZ" "$D/compose.yml" || true)
[[ "$tz_count" == "4" ]] || { echo "compose.yml 时区补丁未生效（期望 4 处，实际 $tz_count）" >&2; exit 1; }
if grep -q 'Asia/Shanghai' "$D/compose.yml"; then echo "compose.yml 仍含 Asia/Shanghai" >&2; exit 1; fi
[[ "$(grep -c 'backend_private' "$D/compose.yml" || true)" == "3" ]] || { echo "compose.yml 持久卷补丁未生效" >&2; exit 1; }

bash -n "$D/install.sh" "$D/configure.sh" "$D/personal-fixups.sh"

# 顶层命令入口（与官方 build-package.sh 相同）
for s in configure preflight install backup restore manage rollback update-docker; do
  cp "$D/root-command.sh" "$STG/$s.sh"; chmod 0755 "$STG/$s.sh"
done
chmod 0755 "$D"/*.sh

if find "$STG" -type f \( -name '.env' -o -name 'deploy.env' -o -path '*/secrets/*' \) -print -quit | grep -q .; then
  echo "包中发现生产配置或 secret" >&2; exit 1
fi
# frontend/dist 里 DKIM 私钥输入框的 placeholder 文案含 "BEGIN PRIVATE KEY"，是界面提示而非密钥（已人工核对），故排除。
if grep -ERli 'BEGIN (RSA|OPENSSH|EC|PRIVATE) KEY' "$STG" | grep -v '/frontend/dist/' | grep -q .; then
  echo "包中发现私钥" >&2; exit 1
fi

tar -C "$OUT/stage" -czf "$OUT/$NAME.tar.gz" "$NAME"
(cd "$OUT" && shasum -a 256 "$NAME.tar.gz" > "$NAME.tar.gz.sha256")
echo "PACKAGE=$OUT/$NAME.tar.gz"
echo "RELEASE=$RELEASE"
du -h "$OUT/$NAME.tar.gz" | cut -f1
