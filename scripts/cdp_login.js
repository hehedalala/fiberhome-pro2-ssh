// cdp_login.js - 通过 Chrome DevTools Protocol 调用路由器页面自身的 $post 完成登录
// 用法: node cdp_login.js
// 依赖: Node.js + Chrome/Edge (无需 ws 模块, 使用 --remote-debugging-pipe)
const { spawn } = require('child_process');

const ROUTER = process.env.ROUTER_IP || '192.168.66.1';
const USER = process.env.FH_USER || 'superadmin';
const PASS = process.env.FH_PASS || 'F1ber$dm';
const CHROME = process.env.CHROME_PATH
    || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

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

    async function evaluate(expr, sessionId) {
        const r = await send('Runtime.evaluate', {
            expression: expr, returnByValue: true, awaitPromise: true
        }, sessionId);
        return r.result?.result?.value ?? JSON.stringify(r.result);
    }

    // 设置为全局，供后续 exec 函数使用
    let sid;
    globalThis.__eval = (expr) => evaluate(expr, sid);

    // 启动并附着到页面
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

    const loginExpr = `new Promise(function(res) {
        $post("DO_WEB_LOGIN", {username: ${JSON.stringify(USER)}, password: ${JSON.stringify(PASS)}})
            .then(function(d) { res(JSON.stringify(d)); })
            .catch(function(e) { res(JSON.stringify({error: String(e)})); });
    })`;
    const result = await evaluate(loginExpr, sid);
    console.log(`[+] Login result: ${result}`);

    const parsed = JSON.parse(result);
    if (parsed.result === 0 && parsed.user === 3) {
        console.log('[+] superadmin login SUCCESS');
    } else {
        console.log('[-] login failed');
        chrome.kill();
        process.exit(1);
    }

    // 保存 CDP 会话信息供其他脚本复用 —— 简单起见，直接进入交互
    // 这里留出扩展点：你可以继续 evaluate 调用 $post

    // 示例: 执行一条命令
    if (process.argv[2] === '--exec') {
        const cmd = process.argv.slice(3).join(' ');
        const content = `x";${cmd};echo "`;
        const execExpr = `new Promise(function(res) {
            $post("send_msg", {recv_number: "10000", encode_schema: "GSM_8BIT", content: ${JSON.stringify(content)}})
                .then(function(d) { res(JSON.stringify(d)); })
                .catch(function(e) { res(JSON.stringify({error: String(e)})); });
        })`;
        const raw = await evaluate(execExpr, sid);
        try {
            const p = JSON.parse(raw);
            let out = p.result || raw;
            if (out.startsWith('3\n')) out = out.substring(2);
            console.log(out);
        } catch (e) { console.log(raw); }
    } else {
        console.log('[*] Login only. Use enable_ssh.js to open SSH, or --exec "cmd" to run a command.');
    }

    chrome.kill();
    process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
