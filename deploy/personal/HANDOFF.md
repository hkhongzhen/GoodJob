# GoodJob 个人部署交接文档

更新：2026-11-19。给下一次对话（或下一位维护者）接着调试用。
本文刻意不含服务器 IP、SSH 密钥路径、邮箱账号和任何密码；这些在维护者本机的私有笔记里。

## 1. 现状一览

| 项目 | 状态 |
|---|---|
| 部署位置 | 一台 VPS，Docker compose 项目名 `goodjobcrm`，网关只监听 `127.0.0.1:4188`，前面由 Caddy 反代到 `https://goodjob.360sanit.com` |
| 版本 | 3.4.0 + Claude Code CLI 适配器（本仓库 fork：`hkhongzhen/GoodJob`，上游 `huangguojia/GoodJob`） |
| 镜像模式 | `GOODJOB_IMAGE_MODE=local`（在服务器上构建；官方 registry 镜像不含本 fork 的代码） |
| 时区 | 所有容器统一 `America/Los_Angeles`（mysql 与 Node 容器必须同一时区，否则 `expires_at > NOW()` 类判断错位） |
| Runner | Mac 本机 Runner 已与服务器配对，获客测试通过 |
| WhatsApp | 已允许 Baileys（非官方通道），见第 4 节；账号创建/扫码**尚未验证** |

## 2. 目录与命令（在服务器上）

- 部署包解压目录：`~/GoodJob-CRM-Docker-<时间戳>/`，升级用 `sudo ./install.sh`（`configure.sh` 只需首次执行）。
- 配置与密钥：`/opt/goodjobcrm/shared`（仅 root 可读）：`deploy.env`、`secrets/`、`backups/`。
- 备份：`sudo ./backup.sh`（`install.sh` 升级前也会自动备份）。备份含 MySQL 全量、上传卷、通信媒体卷、`deploy.env` 与 secrets（所以备份文件本身是敏感的）。**不含** `goodjobcrm_backend_private` 卷（官网线索入口加密设置，丢了可由 `personal-fixups.sh` 重新生成）。
- 查容器：`sudo docker ps`；后端日志：`sudo docker logs --tail 100 goodjobcrm-backend-1`。
- 进库只读查询：
  ```bash
  sudo docker exec goodjobcrm-mysql-1 sh -c 'MYSQL_PWD="$(cat /run/secrets/mysql_root_password)" mysql -u root -t "$MYSQL_DATABASE" -e "SELECT ..."'
  ```
- 网页里的「数据库维护」页不可用于服务器（容器里没有 mysqldump，已用 `MYSQL_LOCAL_BACKUP_ENABLED=false` 关闭），备份一律用 `backup.sh`。

## 3. 打包与升级流程（在本机）

1. 构建：backend / frontend / integration-sdk / whatsapp-plugin 的 `dist` 都要是最新的并通过测试。
2. `deploy/personal/pack.sh <输出目录>` 生成包。它只改「包内副本」，不改仓库里的官方 `deploy/docker-compose`，所以合并上游不会冲突。每处补丁都有断言，失败会直接退出。
3. `scp` 到服务器 → 解压 → `sudo ./install.sh`。

`pack.sh` 对官方部署脚本补了这些上游缺口（每条都真实踩过）：

| 缺口 | 现象 | 补法 |
|---|---|---|
| 官方 `build-package.sh` 引用了仓库里不存在的文件 | 无法打包 | 自己的 `pack.sh` |
| compose 没有给后端挂 `/app/backend/.data` 持久卷 | 生产启动强制要求官网线索入口加密设置，后端反复崩溃（"Production website lead ingress must be enabled"） | 加卷 `goodjobcrm_backend_private`；`personal-fixups.sh` 生成并写入设置 |
| 后端每次迁移都会播种写死密码的内置管理员 `u_superadmin / superadmin@goodjob.com` | 你配置的管理员邮箱密码不生效，公网有已知密码的管理员 | `personal-fixups.sh` 把该行改写成配置的邮箱与密码（**绝不能删这一行**；全新库上必须立刻重做） |
| 只给 mysql 设了 `TZ`，后端/通信容器是 UTC | Runner 配对码永远"已过期" | compose 里统一 `TZ` |
| `install.sh` 默认预置 50 个 beta 管理员 | 无用且有凭据文件 | 默认跳过，`GOODJOB_PROVISION_BETA_ADMINS=true` 才执行 |

## 4. Baileys（非官方 WhatsApp 通道）

- whatsapp-plugin 的生产模式原本强制 `WHATSAPP_OFFICIAL_ONLY=true`。新增显式开关 `WHATSAPP_ALLOW_UNOFFICIAL_IN_PRODUCTION`（默认关闭，不设则行为与上游一致），见 `whatsapp-plugin/src/server/config.ts`、`app.ts`，测试在 `whatsapp-plugin/tests/config.test.ts`。
- `pack.sh` 默认设 `WHATSAPP_OFFICIAL_ONLY=false` + 该开关；`GOODJOB_ALLOW_BAILEYS=false` 可关闭。
- 风险：Baileys 不是官方接口，可能被限制/封号；服务器是机房 IP，风险高于家用网络。用备用号，低频使用。通信容器内存上限 384MB，先只挂一个号。
- 登录会话存在 MySQL（用 `SESSION_MASTER_KEY` 加密），随 `backup.sh` 备份。
- **未验证**：在服务器页面创建 Baileys 账号并扫码。下一步：WhatsApp 页 → 通道选「Baileys 免费非官方通道」→ 勾风险确认 → 创建 → 扫码登录；失败看 `goodjobcrm-communication-1` 日志。

## 5. 2026-11-19 事故：后端崩溃循环（已修）

- 现象：界面弹「需要处理 / 请求失败」。`goodjobcrm-backend-1` 状态 `Restarting`，重启 68 次。
- 原因：收件同步（IMAP，每 2 分钟）处理一封退信，往 `internal_messages` 写通知时 `related_id` 放的是完整邮件 Message-ID（`gj-<uuid>@域名`，超过 64 字符），而列是 `VARCHAR(64)`；MySQL 严格模式报 `Data too long for column 'related_id'`，`persistAll` 里是未捕获的 Promise 异常，整个进程退出，重启后又读到同一封退信。
- 止血（已在服务器执行）：`ALTER TABLE internal_messages MODIFY related_id VARCHAR(255) DEFAULT ''`。
- 源码修复：分支 `fix/internal-message-related-id`（`inbound-mail-watcher.ts` 写入前截断到 255；`mysql-store.ts` 建表改 255，并在 `ensureSchema` 里对旧库按需迁移）。**尚未随新包部署**，下次升级会带上。
- 排查套路：界面报"请求失败" → `docker ps` 看后端是否 `Restarting` → `docker logs` 看第一条 Error。
- 遗留隐患：`persistAll` 的任何一次写库失败都会让进程退出。这是上游设计，若想加固可在调度器入口捕获并记录，而不是让进程崩溃。

## 6. 待办 / 已知问题

1. **退信后「可发信」灯仍是绿色**——已在分支 `fix/bounced-eligibility-light` 修复（**未部署**）。`evaluateProspectEmailOutreachEligibility`（`backend/src/prospect-outreach-eligibility.ts`）新增第四态 `bounced`（标签「邮箱退信」，红色）：
   - 按**收件地址**判定：该团队 `outbound_email_logs` 里存在 `bounced_at` 的地址（忽略大小写）视为已退信；
   - 候选有多个邮箱时，跳过已退信的，改用下一个，仍是「可发信」；全部退信才显示「邮箱退信」；
   - 显式传入收件地址时只判定该地址；
   - 批量发信/自动发信方案/批次放行复核都走这个函数，所以不会再向已退信地址发。
   - 未覆盖：线索/客户页的手动发信（`assertCrmOutreachEligible`）仍不拦已退信地址；退信是永久记录，不区分临时退信（如邮箱已满）。
   测试：`backend/src/prospect-outreach-test.ts` 的 `testBouncedAddressTurnsEligibilityLightOff`。
2. 退信 ≠ 企业没价值。退信通知只有 "Email delivery failed <地址>"（来自发信邮箱服务商的 mailer-daemon），不含原因码。多数是猜的个人邮箱不存在，应补发其他地址（官网公开邮箱、info@/sales@、LinkedIn、电话）。
3. 发信信誉：新域名发信，目前样本里 12 封约 2 封退信（~17%）。退信率高会被邮箱服务商限速甚至停发。建议：只发已验证/官网公开的地址；检查发信域名的 SPF、DKIM、DMARC（邮箱设置页的 DKIM 区目前没配）。
4. 邮箱设置页偶尔显示为空表单（见第 7 节）：**空表单状态下不要点「保存邮箱设置」或「清空邮箱绑定」**，会把服务器上的真实配置覆盖掉。
5. 备份：还没有每日自动备份（注意避开同机其他服务的备份窗口，服务器内存约 3.6GB）；备份尚未拷到本机/异地。
6. 服务器上有未使用的 `admin_credentials.tsv`（configure.sh 生成的 50 个管理员凭据），可删，需用户确认。
7. 上游问题未提：写死密码的内置管理员（是否向上游提 issue 由用户决定）。
8. 已知无关失败：上游 `cli-warm` 测试偶发失败；另一个域名 `sdr` 子站 502 与本部署无关。

## 7. 邮箱设置保存在哪里

都在服务器 MySQL，不在浏览器里，换电脑不会丢：

- 个人默认发件邮箱（SMTP/IMAP/DKIM/签名）：`users` 表，凭据用 `SESSION_MASTER_KEY` 加密。
- 发件邮箱池（自动发信轮换用）：`sender_mailboxes` 表。
- 已发邮件与退信台账：`outbound_email_logs`；触达记录：`prospect_touchpoints`；站内通知：`internal_messages`。

页面显示空表单的原因是前端拉取个人资料失败（例如后端正在崩溃重启时打开页面），不是数据没存。刷新后应当恢复；若刷新后仍为空，先查 `users` 表对应行再排查前端。

## 8. 工作约定（维护者偏好）

- 回复用中文；密码等密钥由用户自己输入，不要代填。
- 不经批准不发送任何真实对外消息（邮件、WhatsApp 等）。
- 改动先走功能分支，用户明确说「合并」后才合并、推送。
- 动生产库（DDL、UPDATE）前先说明，等用户同意。
