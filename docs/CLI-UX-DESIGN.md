# NetMount CLI -- UX 设计

> 目标:做云存储挂载工具里 UX 最好的 CLI。北极星是 `rclone` 的能力 + `gh`/`docker`/`fly` 的手感。
> 核心价值:NetMount 对 rclone + openlist 的**统一抽象**。CLI 的全部 UX 决策都服务于一句话 --
> **用户不该关心一个 storage 背后是 rclone 还是 openlist。**

技术前提(已 recon):数据平面走原生 fetch 打 rclone RC,业务逻辑复用现有 TS,
CLI 通过 runtime-port `{ spawn, fs, osInfo, paths, configIO, notify }` 注入 node 实现。详见 plan。

---

## 1. 七条设计原则

1. **统一优先(Unify over expose):** 一个 storage 一个心智模型。绝不让用户记"这个命令对 rclone 有效、那个对 openlist 有效"。后端是属性,不是分叉。
2. **零配置可用(Zero to working):** 第一次敲 `netmount` 不该看到报错,该看到引导。缺二进制就帮装,没 config 就开向导。
3. **daemon 隐形(Invisible daemon):** 普通用户永远不用手动 `daemon start`。命令按需自启 daemon,只在第一次低调提示一行。控制命令保留给进阶用户。
4. **人机双模(Dual-mode by default):** 同一命令,TTY 下漂亮交互、管道里干净可解析。自动探测,不需要用户加 flag。
5. **错误即指引(Errors are directions):** 每个错误 = 出了什么事 + 为什么 + 下一步敲什么 + 稳定 code。没有死胡同。
6. **破坏需确认(Destructive needs consent):** 删除/覆盖/带删除的 sync 默认确认或 dry-run 预览。脚本用 `--yes`/`--force` 显式解锁。
7. **可发现(Discoverable):** tab 补全补到 storage 名和远端路径;每个 `--help` 带 EXAMPLES;打错给 did-you-mean。

---

## 2. 心智模型与命令语法

混合语法,匹配肌肉记忆 -- 这是经过取舍的决定,不是妥协:

| 类别 | 语法 | 理由 |
|---|---|---|
| **文件操作** | 动词在前: `netmount ls / cp / mv / rm / sync / cat / tree` | rclone 用户对 `rclone ls/copy` 有肌肉记忆,天天用,必须顺手 |
| **资源管理** | 名词分组: `netmount storage <verb>` `netmount config <verb>` `netmount daemon <verb>` | 低频、需要分组,docker/gh/kubectl 范式 |
| **挂载** | 一等动词: `netmount mount` / `netmount unmount` / `netmount ps` | 这是 NetMount 的招牌功能,值得顶层动词 |

> 决策:**不**把文件操作塞进 `netmount file ls` 这种二级名词组。多敲一个 `file` 是天天付的税。rclone 没这么干,我们也不。

---

## 3. 完整命令面(含别名)

```
netmount                          # 无参 = 智能:首次->引导向导;已配置->status 概览
netmount status            (st)   # 招牌仪表盘:daemon/版本/storages/mounts 一屏看全
netmount init                     # 首次引导向导(交互)

# --- 文件操作(动词优先,storage:path 寻址)---
netmount ls    <storage:path>          # 列目录       别名: list, dir
netmount tree  <storage:path>          # 树形列出
netmount cat   <storage:path>          # 打印文件到 stdout(管道友好)
netmount cp    <src> <dst>             # 复制         别名: copy
netmount mv    <src> <dst>             # 移动         别名: move
netmount rm    <storage:path>          # 删除(确认)  别名: remove, del
netmount mkdir <storage:path>
netmount sync  <src> <dst>             # 单向同步(带删除预览)
netmount pull  <storage:path> <local>  # 语义糖:下载
netmount push  <local> <storage:path>  # 语义糖:上传  别名: upload

# --- 挂载(招牌)---
netmount mount   <storage:path> <mountpoint> [--persist]   # 挂载;--persist 进注册表开机重挂
netmount unmount <mount-id | mountpoint | storage:>        # 卸载  别名: umount
netmount ps                            # docker 风格:活跃挂载实时列表  别名: mounts
netmount open    <storage: | mount-id> # 在文件管理器打开挂载点(桌面桥)

# --- storage 管理 ---
netmount storage ls                    # 列所有 storage(含后端、容量、健康)别名: storage list
netmount storage add  [provider]       # 加 storage:TTY->向导, 非 TTY->需完整 flag
netmount storage edit <name>
netmount storage rm   <name>           # 别名: remove, del
netmount storage info <name>
netmount storage test <name>           # 探活:连一下,报延迟/容量/错误

# --- daemon(进阶,普通用户用不到)---
netmount daemon status | start | stop | restart | install-service

# --- 配置 / 诊断 / 补全 ---
netmount config show | get <k> | set <k> <v> | path | edit
netmount doctor [--fix]                # 体检:二进制在不在、WinFsp/FUSE、rc 是否暴露、config 可读
netmount completion <bash|zsh|fish|powershell>
netmount version                       # 自身 + rclone + openlist 三个版本

# --- 全局 flag(所有命令通用)---
  -o, --output  human|json|plain   # 默认 human;TTY 外自动转 plain
  -y, --yes                        # 跳过确认(脚本)
      --dry-run                    # 预览不执行(cp/mv/rm/sync)
  -q, --quiet      / -v, --verbose
      --no-color   / --no-input    # CI 友好
```

设计取舍记录:
- `pull`/`push` 是 `cp` 的语义糖。新手不用想"哪个 storage: 哪个本地",`push 照片/ gdrive:/相册` 方向自明。进阶用户照用 `cp`。
- `storage test` 和 `doctor` 分开:`test` 针对单个 storage 探活,`doctor` 是全局环境体检。
- `ps` 借 docker 心智 -- 活跃实例列表,不是配置列表(那是 `storage ls`)。两者刻意分开。

---

## 4. 寻址:`storage:path` 是通用语

沿用 rclone 的 `remote:path`,因为它是所有 rclone 用户的共识,改了就是制造摩擦。

- `gdrive:` -> storage 根
- `gdrive:/Photos/2026` -> 子路径
- `gdrive:Photos`(无前导斜杠)-> 同上,容错
- tab 补全两段都补:`netmount ls gdr<tab>` -> `gdrive:`,再 `gdrive:/Ph<tab>` -> 远端实际列目录补全
- 后端透明:`gdrive:` 是 rclone 还是 openlist 支撑,命令行为完全一致

本地路径就是裸路径(无冒号):`netmount push ./photos gdrive:/相册`。
有冒号=远端,无冒号=本地。规则一句话讲完。

---

## 5. 输出系统:一套数据,三种呈现

| 模式 | 触发 | 形态 |
|---|---|---|
| **human** | TTY 默认 | 对齐表格、颜色、状态字形、人类可读大小(12.3 GB)、相对时间(3h ago) |
| **json** | `-o json` 或下游需要 | stdout 稳定 JSON,无色无表格无进度条,schema 是契约 |
| **plain** | `-o plain` 或非 TTY 自动 | tab 分隔、无表头、无色,给 `cut`/`awk` |

铁律:
- **stdout 只放结果,stderr 放日志/进度/提示。** `netmount ls gdrive: | wc -l` 必须准。
- 管道检测自动降级:`netmount status | cat` 自动无色、无字形动画。
- 进度条永远走 stderr,`-o json` 时彻底关闭。

状态字形系统(整个 CLI 统一):

```
●  正常 / 运行中 / 已挂载       (绿)
○  停止 / 未挂载               (灰)
⚠  警告 / 降级 / 认证问题       (黄)
✗  失败 / 错误                 (红)
✓  操作成功                    (绿)
⟳  进行中 / 启动中             (青,TTY 下旋转)
```

---

## 6. 首次运行与引导 -- CLI UX 最容易死的地方

`netmount` 无参、无 config 时,**不报错**,进引导:

```
$ netmount
NetMount 还没配置过。要现在设置吗?

  检测环境…
  ● rclone     1.69.1   已安装
  ⚠ openlist   未找到    -> 现在下载?[Y/n]
  ● WinFsp     2.0      已安装(挂载就绪)

  下一步:
    netmount storage add      加第一个云盘
    netmount doctor           完整环境体检

要现在加云盘吗?[Y/n]
```

- 缺二进制 -> 当场提议下载托管版(rclone/openlist 官方 release),不让用户自己折腾 PATH。
- `--no-input`(CI)时:无 config 直接给非交互的下一步提示 + 退出码 3,不挂起等输入。
- 引导写的 config **路径与 GUI 字节一致** -- 装了桌面版的用户,CLI 加的 storage 在 GUI 里立刻可见,反之亦然。这是"统一"承诺的兑现点。

---

## 7. daemon 隐形:按需自启,不是前置仪式

最差的 UX 是逼用户先 `daemon start` 才能干活。我们不这么干。

```
$ netmount mount gdrive: X:
⟳ 启动 netmount 服务… ✓
⟳ 挂载 gdrive: -> X: … ✓
● gdrive: 已挂载到 X:    (netmount ps 查看)
```

- 任何需要 rclone rcd 的命令,发现 daemon 没起就**自动起**,stderr 低调提示一行。
- daemon 管:rclone rcd + openlist server + 挂载子进程 + 挂载注册表。
- `daemon stop/restart/status/install-service` 留给进阶用户和开机自启场景。
- `install-service` 跨平台:Linux systemd --user / macOS launchd / Windows 服务。

---

## 8. 进度与长操作

mount 近乎瞬时;sync/cp 是长活。底层用 rclone RC `_async=true` + `job/status` 轮询(`request.ts` 已有 `rclone_api_exec_async`)。

TTY 下:

```
$ netmount sync ./photos gdrive:/相册
⟳ 同步 ./photos -> gdrive:/相册
  ████████████░░░░░░░░  62%   1.2 GB / 1.9 GB   12 MB/s   ETA 58s
  ↑ 上传 IMG_0431.jpg
  423 / 680 文件
```

管道/CI 下(自动):

```
sync ./photos -> gdrive:/相册
[12%] 234MB/1.9GB
[48%] 912MB/1.9GB
✓ 完成 680 文件 1.9GB in 2m41s
```

- `Ctrl-C` 干净中止:发 `job/stop`,不留半挂状态(`rclone_api_wait_for_job` 已支持 AbortSignal)。

---

## 9. 错误 UX:每个错误都给下一步

格式固定四段:**症状 + 原因 + 下一步 + code**。

```
✗ 挂载失败:WinFsp 未安装
  Windows 上挂载需要 WinFsp 驱动。
  → 自动装:  netmount doctor --fix
  → 手动:    https://winfsp.dev
  (code: MOUNT_WINFSP_MISSING)
```

```
✗ 找不到 storage 'gdrve'
  你是不是想输:  gdrive
  列出全部:      netmount storage ls
  (code: STORAGE_NOT_FOUND)
```

```
✗ rclone 服务未运行,且自启失败
  端口 5572 被占用?
  → 看占用:  netmount doctor
  → 换端口:  netmount config set framework.rclone.port 5580
  (code: RCLONE_NOT_RUNNING)
```

退出码契约(脚本可判定):

```
0  成功
1  通用错误
2  参数/用法错误
3  配置错误(无 config / config 不可读)
4  依赖不可用(rclone/openlist/WinFsp 缺失)
5  挂载失败
6  网络 / RC API 错误
```

错误 code 来自 core 层结构化错误(复用现有 `RepositoryError.code` / `ErrorCode` 模式),不是 CLI 现编。

---

## 10. 交互 vs 脚本:同命令两副面孔

`storage add` 是范例:

```
# TTY + 参数不全 -> 进向导
$ netmount storage add
? 选择云盘类型:  (↑↓ 选, / 搜)
  > Google Drive   (rclone)
    OneDrive        (rclone)
    阿里云盘         (openlist)
    WebDAV          (两者皆可)
? storage 名称:  myDrive
? (OAuth 浏览器授权…)  ✓
● myDrive 已添加

# 非 TTY 或参数齐全 -> 直接执行,不挂起
$ netmount storage add webdav --name nas --url https://x/dav --user alice --password-stdin <<< "$PW"
● nas 已添加
```

铁律:
- **敏感字段永不进 shell history**:`--password-stdin` / 环境变量 / 交互式 Password prompt 三选一,绝不 `--password <明文>` 作为唯一途径。
- 非 TTY + 参数缺 -> **报错说缺哪个**,绝不静默挂起等输入(CI 杀手)。
- `add` 的 provider 列表把 rclone/openlist 后端标在括号里,但用户选的是"阿里云盘"这个**能力**,不是"用哪个引擎" -- 统一抽象在加盘这一刻兑现。

---

## 11. 可发现性

- **补全**:bash/zsh/fish/powershell。动态补全 storage 名(读 config)、远端路径(实时列目录)、mount-id。
- **每个 `--help` 必带 EXAMPLES 段** -- 用户看例子学得最快:
  ```
  $ netmount mount --help
  挂载 storage 到本地路径或盘符。

  用法:  netmount mount <storage:path> <mountpoint> [flags]

  示例:
    netmount mount gdrive: X:                  # Windows 盘符
    netmount mount gdrive:/Photos /mnt/photos  # Linux 路径
    netmount mount nas: Z: --persist           # 开机自动重挂

  Flags:
    --persist        加入注册表,daemon 启动时自动重挂
    --read-only      只读挂载
    --vfs-cache      full|writes|minimal|off  (默认 writes)
  ```
- **did-you-mean**:命令和 storage 名打错都给最近建议。
- `netmount`(无参,已配置)= 直接 `status`,新手敲一下就看到全局状态,自然学会下一步。

---

## 12. 安全:破坏性操作的防线

| 操作 | 防线 |
|---|---|
| `rm` | TTY 确认;`-y` 跳过;非 TTY 无 `-y` -> 拒绝并提示加 `--force` |
| `sync`(会删目标多余文件)| 先打印 `将删除 N 个文件` 预览,再确认;`--dry-run` 只看不做 |
| `storage rm` | 确认 + 显示该 storage 是否有活跃挂载(有则警告先卸载)|
| `unmount` | 有未完成传输时警告 |

`--dry-run` 是 `cp/mv/rm/sync` 的一等公民,输出"将要发生什么"而非执行。

---

## 13. 招牌触感(让它感觉"最好"而不只是"能用")

1. **`netmount status` = 家** -- 一屏看全 daemon、版本、所有 storage 健康、所有挂载吞吐。见 §14 mockup。
2. **`--persist` 持久挂载注册表** -- 这是 NetMount 比裸 rclone 强的地方:挂载记到注册表,daemon 启动/开机时自动重挂。裸 rclone 要用户自己写 systemd unit。
3. **`netmount ps`** -- docker 手感,活跃挂载带实时吞吐。
4. **`netmount open gdrive:`** -- 从 CLI 直接在文件管理器打开挂载点。CLI/GUI 桥,符合 NetMount 定位。
5. **`storage test`** -- 加完盘当场探活报延迟,不用挂载后才发现配错。
6. **GUI/CLI 实时同源** -- CLI 改 config,GUI 订阅了 config 变更会即时刷新(`ConfigService` 已有 subscription 模式)。装了桌面版的用户体验是"一套状态两个入口"。

---

## 14. 关键屏幕 mockup(money shots)

`netmount status`:

```
NetMount  ● running    rclone 1.69.1 · openlist 4.0.2
RC api    127.0.0.1:5572 (authed)            config ~/.config/NetMount/config.json

STORAGES (4)
  ● gdrive       googledrive   rclone      12.3 GB / 2 TB
  ● oneSchool    onedrive      rclone      —
  ● nas          webdav        openlist    1.1 TB / 4 TB
  ⚠ oldS3        s3            rclone      认证错误  -> netmount storage test oldS3

MOUNTS (2)
  ● gdrive:      -> X:           ↓ 12 MB/s    up 3h
  ○ nas:/media   -> /mnt/media   已停止       -> netmount mount nas:/media /mnt/media
```

`netmount ps`:

```
MOUNT ID   STORAGE       MOUNTPOINT     STATUS    THROUGHPUT   UPTIME
m-7f3a     gdrive:       X:             ● up      ↓12MB/s      3h12m
m-2b91     nas:/media    /mnt/media     ○ stopped —            —
```

`netmount ls gdrive:/Photos`:

```
   2.1 MB   2026-05-01 14:22   IMG_0431.jpg
   1.8 MB   2026-05-01 14:23   IMG_0432.jpg
      —     2026-04-12 09:10   Albums/
```

`netmount ls gdrive:/Photos -o json`(stdout,契约):

```json
{"items":[
  {"name":"IMG_0431.jpg","size":2202009,"modTime":"2026-05-01T14:22:00Z","isDir":false},
  {"name":"Albums","size":0,"modTime":"2026-04-12T09:10:00Z","isDir":true}
]}
```

---

## 15. 落地映射(保证设计不是空中楼阁)

| UX 能力 | 底层 |
|---|---|
| 文件操作 / ls / sync 进度 | 现有 `rclone_api_post` / `rclone_api_exec_async`(fetch,跨端可用)|
| storage 列表 / 健康 | `controller/storage/allList` + `framework/*/providers`(复用)|
| daemon 自启 / sidecar | runtime-port `spawn` -> node:child_process(对应 `utils/sidecar.ts`)|
| config 读写 / 路径一致 | runtime-port `configIO` + `paths`(对应 `ConfigService` / `config.rs`)|
| 错误 toast -> stderr | runtime-port `notify`(替换 `request.ts` 里的 Arco `Message`)|
| 错误 code | 复用 `ErrorCode` / `RepositoryError.code` 结构 |
| 状态字形 / 颜色 / TTY 检测 | CLI 表现层新写(`cli/render/`),~200 行,无重型依赖 |
| 交互向导 | `inquire` 等价(node: `@inquirer/prompts` / `clack`)|
| 参数解析 | `commander` 或 `clipanion`(支持子命令树 + 动态补全)|

> 表现层(字形/颜色/表格/进度)是 CLI 唯一该"自己写"的部分,且刻意保持薄 -- 不引重型 TUI 框架(anthropic-design-philosophy:34 行能解决别引依赖)。业务逻辑一行不重写。

---

## 不学的 anti-patterns

- 逼用户先 `daemon start` 才能干活(很多自带 daemon 的 CLI 的通病)
- 把文件操作埋进 `netmount file ls` 二级名词组(天天付税)
- `--json` 还往 stdout 混日志/进度(破坏管道)
- 报错只说"failed"不给下一步
- 明文密码作为唯一传参途径
- 非 TTY 下静默挂起等输入(CI 杀手)
- 引重型 TUI 框架做 200 行能干的表现层
```
