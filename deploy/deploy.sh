#!/usr/bin/env bash
# vcash 生产部署脚本（1Panel 环境：PM2 + OpenResty + PostgreSQL）
#
# 使用方式：
#   1. 将代码上传到服务器（如 /opt/vcash）
#   2. 在 1Panel PostgreSQL 中创建数据库 vcash 和用户（记录密码）
#   3. 执行：DB_PASSWORD=your_password bash deploy/deploy.sh
#   4. 在 1Panel PM2 管理器中添加项目（指向 ecosystem.config.cjs，配置环境变量）
#   5. 在 1Panel 网站中添加反代站点（127.0.0.1:3000），申请 SSL

set -euo pipefail

# 颜色输出
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log()  { echo -e "${GREEN}[deploy]${NC} $1"; }
warn() { echo -e "${YELLOW}[warn]${NC} $1"; }
err()  { echo -e "${RED}[error]${NC} $1" >&2; exit 1; }

# 切换到项目根目录（deploy/ 的上级）
cd "$(dirname "$0")/.."
PROJECT_ROOT="$(pwd)"
log "项目根目录: $PROJECT_ROOT"

# ===== 1. 环境检查 =====
log "检查运行环境..."

command -v node >/dev/null 2>&1 || err "未安装 Node.js（需要 20+）"
NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
[ "$NODE_VERSION" -ge 20 ] || err "Node.js 版本过低（当前 $NODE_VERSION，需要 20+）"

command -v pnpm >/dev/null 2>&1 || {
  warn "未安装 pnpm，正在安装..."
  npm install -g pnpm@9.12.0
}

log "Node.js: $(node -v) / pnpm: $(pnpm -v)"

# ===== 2. 检查 vendure 本地依赖 =====
# vcash 依赖 file:../../vendure/packages/{cjk,member-level}-plugin
VENDURE_DIR="$(dirname "$PROJECT_ROOT")/vendure"
if [ ! -d "$VENDURE_DIR/packages/cjk-plugin" ] || [ ! -d "$VENDURE_DIR/packages/member-level-plugin" ]; then
  err "vendure 本地依赖缺失：$VENDURE_DIR/packages/{cjk-plugin,member-level-plugin}
请将 vendure 仓库 clone 到 $VENDURE_DIR：
  git clone https://github.com/johocn/vendure.git $VENDURE_DIR
  cd $VENDURE_DIR/packages/cjk-plugin && pnpm install && pnpm build
  cd $VENDURE_DIR/packages/member-level-plugin && pnpm install && pnpm build"
fi
log "vendure 本地依赖: OK"

# ===== 3. 检查数据库连接 =====
if [ -z "${DB_PASSWORD:-}" ]; then
  warn "未设置 DB_PASSWORD 环境变量，请在 1Panel PM2 管理器中配置"
  warn "或使用：DB_PASSWORD=your_password bash deploy/deploy.sh"
fi

# ===== 4. 安装依赖 =====
log "安装依赖（pnpm install）..."
pnpm install --no-frozen-lockfile

# ===== 5. 构建 =====
log "构建所有包..."
pnpm -r build
log "构建完成"

# ===== 6. 创建必要目录 =====
mkdir -p logs server/assets server/email-output

# ===== 7. 初始化数据库 schema（首次部署）=====
if [ "${RUN_MIGRATE:-0}" = "1" ]; then
  log "执行数据库 migrate（synchronize）..."
  # Vendure 在生产环境通过 synchronize:true 自动建表
  # 注意：生产环境首次启动会自动建表，后续修改 schema 需手动 migrate
  warn "首次部署时 Vendure 会自动建表（synchronize:true）"
fi

# ===== 8. 填充初始数据（可选）=====
if [ "${RUN_POPULATE:-0}" = "1" ]; then
  log "填充初始数据..."
  pnpm populate || warn "populate 失败，请检查数据库连接"
fi

# ===== 9. 输出后续步骤 =====
echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  部署准备完成！${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo "后续在 1Panel 中操作："
echo ""
echo "1. PostgreSQL 数据库："
echo "   - 已创建数据库 vcash 和用户 vcash"
echo "   - 密码：$DB_PASSWORD"
echo ""
echo "2. PM2 管理器："
echo "   - 添加项目，项目路径：$PROJECT_ROOT"
echo "   - 启动文件：ecosystem.config.cjs"
echo "   - 环境变量配置："
echo "       DB_PASSWORD=$DB_PASSWORD"
echo "       DB_HOST=localhost"
echo "       DB_PORT=5432"
echo "       DB_USERNAME=vcash"
echo "       DB_DATABASE=vcash"
echo ""
echo "3. 网站（OpenResty 反代）："
echo "   - 创建反代站点，域名：your-domain.com"
echo "   - 反代目标：127.0.0.1:3000"
echo "   - 申请 SSL 证书（Let's Encrypt）"
echo "   - 参考：deploy/nginx-vcash.conf.example"
echo ""
echo "4. 验证："
echo "   - 本地验证：curl http://127.0.0.1:3000/health"
echo "   - 公网验证：https://your-domain.com"
echo ""
