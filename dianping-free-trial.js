'ui';

const appPackage = 'com.dianping.v1';
const threshold = 150;
const maxRounds = 4;
const stepMinimum = 4000;
const stepMaximum = 10000;
const firstPageProbe = 1800;
const pagePoll = 450;
const storage = storages.create('dianping_free_trial_v1');
const normalize = value => String(value || '').normalize('NFKC').replace(/[\s·•、，。｜|。：:…（）()<>＞《》！!?▼▽▾▿⌄\-]/g, '').toLowerCase();
const orangeGate = /橙\s*[VvⅤ]\s*(?:专享|專享|专属|專屬|会员|會員)|(?:点亮|點亮)\s*橙|(?:仅限|僅限|限)\s*橙\s*[VvⅤ]|[Ll][Vv]\s*6\s*[-–~至]\s*8/;
const reviewPrompt = /[写寫](?:评价|評價).{0,8}(?:点亮|點亮)橙v/;
const footerPattern = /暂[无無]更多|暫[无無]更多|没有更多|沒有更多|已经到底|已到底|到底啦|全部加载完毕/;
const blockingPattern = /(?:请先|請先|请完成|請完成|需要|请输入|請輸入).{0,8}(?:登录|登入|验证码|驗證碼)|本[机機][号號][码碼]一[键鍵](?:登录|登入)|滑[块塊][验驗][证證]|安全[验驗][证證]|操作太[频頻]繁|报名次数已达|达到.{0,6}上限|网络异常|服务异常/;
const loadingPattern = /^(?:正在)?(?:加载中|載入中|加載中|读取中|讀取中|刷新中|加载数据中|請稍候|请稍候|请稍等|請稍等)[.。… ]*$/;
const anchorPattern = /^(?:首页|首頁|个人|個人|个人主页|個人主頁|[尽盡]享吃喝玩[乐樂]|免费试天天抽|免費試天天抽|全部分[类類]|全部商[区區]|美食|智能排序|同品牌相似活动|免费试活动详情|我要报名|确认报名信息|确认报名|报名结果|报名成功|查看更多活动|活动门店|暂无更多活动.*|暂無更多活动.*|[写寫](?:评价|評價).*|新增(?:评价|評價)|(?:适用商户|適用商戶).*|.*[（(][^）)]{1,24}[店舖铺][）)]|好正|口味|环境|環境|服务|服務|匿名(?:评价|評價).*|我知道了|發佈|發布|发布|存草稿)$/;
const getText = (view, words, predicate) => view.find(node => normalize(node.text) === normalize(words) && (!predicate || predicate(node)));
const storeKey = item => [item.value, normalize(item.title).slice(0, 24), normalize(item.branch)].join(':');
const finished = new Set();
const skipped = new Set();
const scanCandidates = new Set();
const scanUnresolved = new Set();
let screenWidth = 1080;
let screenHeight = 2424;
let submitted = 0;
let dryRun;
let diagnostics = '';
let captureRequested = false;
let reviewEditorOpen = false;
let reviewHandoff = '';
let lastStep = null;

function report(message) {
    log(new Date().toLocaleTimeString() + ' ' + message);
}

function requireForeground() {
    if (currentPackage() !== appPackage) throw new Error('大众点评不在前台，请解锁并保持页面可见');
}

function act(label, operation, needsForeground = true) {
    if (lastStep) {
        const elapsed = Date.now() - lastStep.at;
        if (elapsed < stepMinimum) sleep(stepMinimum - elapsed);
        if (Date.now() - lastStep.at > stepMaximum) throw new Error('「' + lastStep.label + '」后已超过 10 秒，未执行「' + label + '」');
    }
    if (needsForeground) requireForeground();
    if (!operation()) throw new Error('未完成「' + label + '」操作');
    lastStep = { label, at: Date.now() };
}

function press(x, y, label = '点击控件', before) {
    act(label, function () {
        if (before) before();
        return click(Math.round(x * screenWidth / 1080), Math.round(y * screenHeight / 2424));
    });
}

function tap(node, before) {
    if (!node) throw new Error('未确认目标按钮');
    press(node.x + node.w / 2, node.y + node.h / 2, node.text, before);
}

function previousPage() {
    act('返回', () => { back(); return true; });
}

function wordsWithBounds(text, bounds) {
    return {
        text: String(text || ''),
        x: Number(bounds.left) * 1080 / screenWidth, y: Number(bounds.top) * 2424 / screenHeight,
        w: Number(bounds.right - bounds.left) * 1080 / screenWidth, h: Number(bounds.bottom - bounds.top) * 2424 / screenHeight
    };
}

function readable(node) {
    return node.text && node.w > 0 && node.h > 0 && node.x >= 0 && node.y >= 0 && node.y + node.h <= 2440;
}

function listItems(results) {
    if (results && typeof results.size === 'function' && typeof results.get === 'function') {
        const items = [];
        for (let index = 0; index < results.size(); index += 1) items.push(results.get(index));
        return items;
    }
    return Array.from(results || []);
}

function capture() {
    requireForeground();
    const frame = captureScreen();
    screenWidth = frame.getWidth();
    screenHeight = frame.getHeight();
    if (screenWidth >= screenHeight) throw new Error('请将手机保持竖屏');
    const bitmap = images.copy(frame);
    try {
        const scanned = listItems(paddle.ocr(bitmap)).map(result => wordsWithBounds(result.text || result.words, result.bounds)).filter(readable);
        const anchors = listItems(textMatches(anchorPattern).packageName(appPackage).find()).map(node => wordsWithBounds(node.text(), node.bounds())).filter(readable);
        diagnostics = screenWidth + '×' + screenHeight + '｜文字 ' + scanned.length + ' 处｜界面标记 ' + anchors.length + ' 处';
        return scanned.concat(anchors.filter(anchor => !scanned.some(node => normalize(node.text) === normalize(anchor.text) && Math.abs(node.y - anchor.y) < 55)));
    } finally {
        bitmap.recycle();
    }
}

function waitFor(predicate, reason) {
    const step = lastStep || { label: '当前页面', at: Date.now() };
    const earliest = step.at + stepMinimum;
    const deadline = step.at + stepMaximum;
    const probeDelay = step.at + firstPageProbe - Date.now();
    if (probeDelay > 0) sleep(probeDelay);
    let consecutive = 0;
    let view;
    let checkedAt;
    let remaining;
    while (Date.now() < deadline) {
        view = capture();
        if (view.some(node => blockingPattern.test(node.text))) throw new Error('页面要求验证、重新登录，或出现网络或平台限制；已停止');
        consecutive = !view.some(node => loadingPattern.test(node.text.trim())) && predicate(view) ? consecutive + 1 : 0;
        checkedAt = Date.now();
        remaining = deadline - checkedAt;
        if (consecutive >= 2 && checkedAt >= earliest && remaining >= 0) {
            report('页面就绪：「' + step.label + '」后 ' + ((checkedAt - step.at) / 1000).toFixed(1) + ' 秒');
            return view;
        }
        if (remaining <= 0) break;
        sleep(Math.min(consecutive >= 2 ? earliest - checkedAt : pagePoll, remaining));
    }
    report('识别诊断：' + diagnostics);
    throw new Error('10 秒内未能确认页面就绪：' + reason);
}

function isHome(view) {
    if (typeof id === 'function' && id('com.dianping.v1:id/title_search_bar').exists() && id('com.dianping.v1:id/home_tab_home_container').exists()) return true;
    return view.some(node => node.x < 250 && node.y > 2150 && /首页|首頁/.test(node.text)) &&
        view.some(node => node.x > 815 && node.y > 2150 && /个人|個人/.test(node.text));
}

function foodFilter(view) {
    return getText(view, '美食', node => node.x > 245 && node.x < 490 && node.y < 1750);
}

function isList(view) {
    return foodFilter(view) && view.some(node => /全部商[区區]|智能排序/.test(node.text));
}

function loadedActivities(view) {
    return recognizableAmounts(view).some(item => item.node.y > 420 && item.node.y < 2190) ||
        view.some(node => node.y > 430 && footerPattern.test(node.text));
}

function readyList(view) {
    return isList(view) && loadedActivities(view);
}

function trialEntry(view) {
    return view.find(node => node.x > 525 && node.x < 820 && node.y > 650 && node.y < 1150 && /[费費][试試]|[尽盡]享吃喝/.test(node.text));
}

function readyHome(view) {
    return isHome(view) && trialEntry(view);
}

function groupHeader(view) {
    return getText(view, '同品牌相似活动', node => node.y > 450 && node.x > 245 && node.x < 620);
}

function isProfile(view) {
    return view.some(node => /个人主页|個人主頁/.test(node.text)) || textMatches(/个人主页|個人主頁/).packageName(appPackage).exists();
}

function checkNetwork() {
    const manager = context.getSystemService(android.content.Context.CONNECTIVITY_SERVICE);
    const network = manager.getActiveNetwork();
    const capabilities = network && manager.getNetworkCapabilities(network);
    if (!capabilities || !capabilities.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_VALIDATED)) throw new Error('Android 未确认网络可访问互联网');
}

function reopen(view) {
    checkNetwork();
    if (!isHome(view)) {
        if (!isList(view) || groupHeader(view)) throw new Error('重进前未确认位于美食列表');
        press(72, 195, '回首页');
        view = waitFor(readyHome, '未回到大众点评首页');
    }
    tap(trialEntry(view));
    const category = page => page.find(node => node.x > 255 && node.x < 500 && node.y < 1760 && /全部分[类類]/.test(node.text));
    const trial = waitFor(page => category(page) && loadedActivities(page) && page.some(node => /天天抽|全部商[区區]/.test(node.text)), '重进后未确认「免费试天天抽」已加载');
    tap(category(trial));
    const food = page => getText(page, '美食', node => node.x < 160 && node.y > 380 && node.y < 740);
    tap(food(waitFor(food, '分类菜单中未识别到「美食」')));
    return waitFor(readyList, '重选后「美食」活动未加载');
}

function recognizableAmounts(view) {
    const pattern = /价[值直]\s*[¥￥]?\s*([0-9][0-9 ,，]*(?:\.[0-9]{1,2})?)\s*[元兀]/;
    return view.filter(node => node.x >= 235 && node.x < 410 && /价[值直]/.test(node.text)).map(node => {
        const row = view.filter(part => part.x > node.x + 9 && part.x < 575 && Math.abs(part.y - node.y) < 21).sort((left, right) => left.x - right.x);
        const match = (node.text + ' ' + row.map(part => part.text).join(' ')).normalize('NFKC').match(pattern);
        return match ? { node: node, value: Number(match[1].replace(/[ ,，]/g, '')) } : null;
    }).filter(Boolean);
}

function activityFloor(view, header) {
    const filter = foodFilter(view);
    return header ? header.y + header.h + 10 : (filter ? filter.y + 140 : 410);
}

function activityButtons(view, floor) {
    return view.filter(node => node.x > 825 && node.y >= floor && node.y < 2185 && /^(?:免费抽|免費抽)$/.test(normalize(node.text)));
}

function cards(view, header) {
    const floor = activityFloor(view, header);
    const buttons = activityButtons(view, floor);
    return recognizableAmounts(view).filter(result => result.node.y > floor && result.node.y < 2190).map(result => {
        const node = result.node;
        const lines = view.filter(part => part.x >= 235 && part.x < 810 && part.y > floor + (header ? 0 : 38) && node.y - part.y >= 122 && node.y - part.y <= 226)
            .sort((left, right) => left.y - right.y || left.x - right.x);
        const top = lines[0];
        const title = top ? lines.filter(part => Math.abs(part.y - top.y) < 34).sort((left, right) => left.x - right.x).map(part => part.text).join(' ') : '';
        const branchLine = top && view.find(part => part.x >= 235 && part.x < 540 && part.y - top.y > 40 && part.y - top.y < 110);
        const branchMatch = branchLine && branchLine.text.match(/^(?!多门店|多間門店)(.{2,28}?[店舖铺])(?:[ |：:，、]|$)/);
        return {
            title: title, branch: branchMatch ? branchMatch[1] : '', value: result.value,
            button: buttons.find(part => Math.abs(part.y - node.y) < 43),
            related: !header && view.find(part => part.x >= 230 && part.y > node.y && part.y - node.y < 135 && /同品牌其他.{0,6}相似活动/.test(part.text))
        };
    });
}

function noteUnresolved(view, items, header) {
    const floor = activityFloor(view, header);
    activityButtons(view, floor + (header ? 122 : 264)).forEach(button => {
        const item = items.find(entry => entry.button === button);
        if (item && (item.title || item.value < threshold)) return;
        const value = item ? '¥' + item.value : '价值无法辨认';
        const nearby = view.filter(node => node.x >= 235 && node.x < 810 && button.y - node.y >= 35 && button.y - node.y <= 226)
            .map(node => normalize(node.text)).filter(Boolean).slice(0, 3).join(':');
        const key = value + ':' + (nearby || Math.round(button.y / 60));
        if (scanUnresolved.has(key)) return;
        scanUnresolved.add(key);
        report('待核对：' + (item ? '未能辨认活动名称（' + value + '）' : '「免费抽」未对应到可辨认的价值'));
    });
}

function scanSummary() {
    return '可报名候选 ' + scanCandidates.size + ' 项（未核验详情），跳过 ' + skipped.size + ' 条，待核对 ' + scanUnresolved.size + ' 条。';
}

function assess(item) {
    if (!item.title || !Number.isFinite(item.value)) return false;
    const key = storeKey(item);
    if (finished.has(key)) return false;
    if (item.value < threshold || (dryRun && orangeGate.test(item.title))) {
        if (!skipped.has(key)) report('跳过 ¥' + item.value + ' ' + item.title + '：' + (item.value < threshold ? '低于门槛' : '橙V限制'));
        skipped.add(key);
        return false;
    }
    if (dryRun && item.button && !scanCandidates.has(key)) {
        report('只扫描候选 ¥' + item.value + ' ' + item.title + ' ' + item.branch);
        scanCandidates.add(key);
    }
    return !dryRun && Boolean(item.button);
}

function closeGroup(view) {
    const header = groupHeader(view);
    if (!header) throw new Error('无法确认相似活动弹窗');
    press(1010, header.y + header.h / 2, '关闭相似活动');
    return waitFor(page => readyList(page) && !groupHeader(page), '关闭弹窗后未回到美食列表');
}

function listFooter(view) {
    if (typeof textMatches === 'function') {
        const native = textMatches(/^(?:暫[無无]|暂[無无])更多活動.*$|^(?:暫[無无]|暂[無无])更多活动.*$/).packageName(appPackage).findOne(120);
        if (native) {
            const marker = wordsWithBounds(native.text(), native.bounds());
            if (readable(marker) && marker.y > 780) return marker;
        }
    }
    return view.find(node => node.y > 780 && footerPattern.test(node.text));
}

function backToList() {
    previousPage();
    return waitFor(view => readyList(view) || groupHeader(view), '返回后未确认活动列表');
}

function matchesName(view, item) {
    const name = normalize(item.title).slice(0, 8);
    return name.length >= 5 && view.some(node => node.y > 730 && node.y < 1250 && normalize(node.text).includes(name));
}

function hasReviewPrompt(view) {
    return view.some(node => reviewPrompt.test(normalize(node.text))) || view.some(node => {
        if (!/[写寫](?:评价|評價).{0,5}$/.test(normalize(node.text))) return false;
        return view.some(part => part !== node && Math.abs(part.y - node.y) < 65 && Math.abs(part.x - node.x) < 390 &&
            reviewPrompt.test(normalize(node.text + part.text)));
    });
}

function reviewMerchant(detail, branch) {
    const heading = detail.find(node => node.x < 260 && node.y > 650 && node.y < 1860 && /^(?:适用商户|適用商戶)/.test(node.text));
    if (!heading) return null;
    const matching = detail.filter(node => node.x < 210 && node.y > heading.y + 28 && node.y < heading.y + 190 &&
        /[（(][^）)]{1,24}[店舖铺][）)]/.test(node.text) && (!branch || normalize(node.text).includes(normalize(branch))));
    const distinct = matching.filter((node, index) => !matching.slice(0, index).some(previous => normalize(previous.text) === normalize(node.text)));
    const multiple = /[2-9]|[0-9]{2}/.test(heading.text) || detail.some(node => node.x > heading.x + 95 && node.x < 320 &&
        Math.abs(node.y - heading.y) < 35 && /^[（(](?:[2-9]|\d{2,})[）)]$/.test(node.text));
    if (distinct.length !== 1 || (!branch && multiple)) return null;
    return distinct[0];
}

function reviewWriteButton(view) {
    return view.find(node => node.x >= 120 && node.x < 375 && node.y > 2130 && /^[写寫][评評][价價僓]$/.test(normalize(node.text)));
}

function reviewEditor(view, merchant) {
    return view.some(node => node.y < 330 && normalize(node.text).includes(normalize(merchant))) &&
        view.some(node => node.y > 2080 && /^(?:發布|發佈|发布)$/.test(normalize(node.text))) &&
        view.some(node => node.y > 1000 && /匿名(?:评价|評價)/.test(node.text));
}

function screenPixel(frame, x, y) {
    const pixel = Number(images.pixel(frame, Math.round(x * screenWidth / 1080), Math.round(y * screenHeight / 2424)));
    return [(pixel >>> 16) & 255, (pixel >>> 8) & 255, pixel & 255];
}

function isOrange(pixel) {
    return pixel[0] >= 195 && pixel[0] - pixel[1] >= 57 && pixel[0] - pixel[2] >= 70;
}

function halfReviewStar(left, right, y) {
    requireForeground();
    const frame = captureScreen();
    return [0, -4, 4, -8, 8].some(offset => {
        const color = screenPixel(frame, right, y + offset);
        const highest = Math.max(color[0], color[1], color[2]);
        const lowest = Math.min(color[0], color[1], color[2]);
        return isOrange(screenPixel(frame, left, y + offset)) && highest - lowest < 24 && highest < 247 && lowest > 140;
    });
}

function anonymousSelected(y) {
    requireForeground();
    const frame = captureScreen();
    return [70, 89].every(x => [-5, 0, 5].some(offset => isOrange(screenPixel(frame, x, y + offset))));
}

function setReviewOptions(initial, merchant) {
    const ready = view => reviewEditor(view, merchant);
    const scoreRows = view => [/^口味/, /^(?:环境|環境)/, /^(?:服务|服務)/].map(pattern =>
        view.find(node => node.x < 145 && node.y > 640 && node.y < 1090 && pattern.test(normalize(node.text))));
    const totalSelected = () => halfReviewStar(949, 1003, 566);
    const totalOption = view => view.find(node => node.x > 690 && node.y < 580 && /^4\.?5星$/.test(normalize(node.text)));
    if (!initial.some(node => node.y > 550 && node.y < 1500 && /大家都在[问問].{0,12}菜品口味|菜品口味如何.{0,12}服[务務]态度/.test(normalize(node.text)))) {
        throw new Error('无法确认评价正文为空；请手动处理，脚本未更改评分或匿名状态');
    }
    const grade = initial.find(node => node.x >= 890 && node.y >= 395 && node.y < 515 && /好正$/.test(normalize(node.text)));
    if (!grade) throw new Error('未确认总评「好正」的位置');
    let view = initial;
    if (!totalSelected()) {
        press(980, 546, '总评好正');
        view = waitFor(page => ready(page) && (totalOption(page) || (totalSelected() && scoreRows(page).every(Boolean))), '未确认总评 4.5 星选项');
        if (!totalSelected()) {
            tap(totalOption(view));
            view = waitFor(page => ready(page) && totalSelected() && scoreRows(page).every(Boolean), '未确认总评为 4.5 星');
        }
    }
    const scores = scoreRows(view);
    if (scores.some(node => !node) || scores.some((node, index) => index > 0 && Math.abs(node.y - scores[index - 1].y - 136) > 28)) throw new Error('未确认口味、环境和服务评分区');
    scores.forEach(node => {
        const y = Math.round(node.y + node.h / 2);
        if (halfReviewStar(835, 867, y)) return;
        press(834, y, node.text + ' 4.5 星');
        view = waitFor(page => ready(page) && halfReviewStar(835, 867, y), '未确认「' + node.text + '」为 4.5 星');
    });
    const anonymous = view.find(node => node.x > 45 && node.x < 160 && node.y > 1260 && node.y < 2080 && /匿名(?:评价|評價)/.test(node.text));
    if (!anonymous) throw new Error('未确认匿名评价开关');
    const y = Math.round(anonymous.y + anonymous.h / 2);
    if (!anonymousSelected(y)) {
        const notice = page => page.some(node => /(?:为|為)避免.*(?:身份|身分)|知晓你的身份|知曉你的身分/.test(node.text));
        press(81, y, '勾选匿名评价');
        const checked = waitFor(page => notice(page) || (ready(page) && anonymousSelected(y)), '未确认匿名评价已勾选');
        if (notice(checked)) {
            const acknowledgment = getText(checked, '我知道了', node => node.y < 2150);
            if (!acknowledgment) throw new Error('请手动确认匿名说明');
            tap(acknowledgment);
            waitFor(page => ready(page) && !notice(page) && anonymousSelected(y), '未确认匿名说明关闭且匿名评价已勾选');
        }
    }
}

function prepareReview(detail, item) {
    const merchant = reviewMerchant(detail, item.branch);
    if (!merchant) throw new Error('橙V提示已识别，但无法确认适用分店；未进入评价页');
    const shop = view => view.some(node => node.y < 900 && normalize(node.text).includes(normalize(merchant.text))) && reviewWriteButton(view);
    tap(merchant);
    tap(reviewWriteButton(waitFor(shop, '未确认打开了对应分店的「写评价」入口')));
    const addReview = view => view.find(node => node.y > 1450 && node.y < 2180 && /^新增(?:评价|評價)$/.test(normalize(node.text)));
    let editor = waitFor(view => addReview(view) || reviewEditor(view, merchant.text), '未看到「新增评价」或该分店的评价编辑页');
    if (!reviewEditor(editor, merchant.text)) {
        tap(addReview(editor));
        editor = waitFor(view => reviewEditor(view, merchant.text), '未确认打开了该分店的评价编辑页');
    }
    reviewEditorOpen = true;
    setReviewOptions(editor, merchant.text);
    reviewHandoff = merchant.text;
    report('已暂停在「' + merchant.text + '」评价页：总评、口味、环境和服务均 4.5 星，已选匿名；请自行写正文');
    toast('评价已准备，请自行填写正文');
    return null;
}

function readyDetail(view) {
    return getText(view, '免费试活动详情') && (hasReviewPrompt(view) || getText(view, '我要报名', node => node.y > 2080) ||
        view.some(node => node.y > 2000 && /点亮橙|點亮橙|橙V专享|橙V專享/.test(node.text)));
}

function enroll(item, fromGroup) {
    const description = '¥' + item.value + ' ' + item.title + (item.branch ? '（' + item.branch + '）' : '');
    tap(item.button);
    const detail = waitFor(readyDetail, '未确认活动详情和报名区已加载');
    if (!dryRun && hasReviewPrompt(detail)) return prepareReview(detail, item);
    if (detail.some(node => /(?:点亮|點亮)\s*橙/.test(node.text) || (node.y > 780 && node.y < 1085 && orangeGate.test(node.text)))) {
        finished.add(storeKey(item));
        report('跳过 ' + description + '：详情显示橙V限制');
        return backToList();
    }
    if (!matchesName(detail, item)) throw new Error('详情名称不匹配：' + description);
    if (!detail.some(node => node.x < 140 && node.y >= 880 && node.y < 1360 && /^[¥￥]\s*0(?:\s|[¥￥①②③]|$)/.test(node.text.normalize('NFKC')))) throw new Error('未确认活动价格为零：' + description);
    const expectedBranch = normalize(item.branch).replace(/店$/, '');
    if (fromGroup && expectedBranch.length < 3) throw new Error('相似活动门店未确认：' + description);
    if (expectedBranch && !detail.some(node => normalize(node.text).includes(expectedBranch))) throw new Error('详情门店未匹配：' + description);
    tap(getText(detail, '我要报名', node => node.x > 520 && node.y > 2080));
    const modal = waitFor(view => getText(view, '确认报名信息') || hasReviewPrompt(view) || view.some(node => /(?:点亮|點亮)\s*橙/.test(node.text)), '未确认报名弹窗');
    if (!dryRun && hasReviewPrompt(modal)) {
        previousPage();
        return prepareReview(waitFor(readyDetail, '看到橙V提示，但未能返回活动详情'), item);
    }
    if (modal.some(node => /(?:点亮|點亮)\s*橙/.test(node.text))) {
        finished.add(storeKey(item));
        report('跳过 ' + description + '：报名要求点亮橙V');
        press(1020, 1457, '关闭橙 V 限制提示');
        return backToList();
    }
    const confirm = getText(modal, '确认报名', node => node.x > 310 && node.x < 700 && node.y > 2100);
    if (!confirm || !modal.some(node => node.y > 1490 && node.y < 1840 && /^活动门店/.test(node.text)) ||
        !modal.some(node => /免费试用户规则/.test(node.text)) || modal.some(node => /实付|立即支付|付费报名|实际支付/.test(node.text))) throw new Error('未确认是已验证的零元报名弹窗：' + description);
    if (expectedBranch && !modal.some(node => node.y > 1500 && normalize(node.text).includes(expectedBranch))) throw new Error('确认门店不匹配：' + description);
    tap(confirm, () => {
        storage.put('pending', description);
        report('提交 ' + description);
    });
    const result = waitFor(view => getText(view, '报名结果') && getText(view, '报名成功'), '已提交但未看到成功结果，请人工核对，勿重复报名');
    storage.remove('pending');
    finished.add(storeKey(item));
    submitted += 1;
    const draw = result.find(node => /20[0-9]{2}[-./年][0-9]{1,2}[-./月][0-9]{1,2}/.test(node.text));
    report('报名成功 ' + description + (draw ? '｜' + draw.text : ''));
    tap(getText(result, '查看更多活动', node => node.y > 650 && node.y < 1040));
    return waitFor(view => readyList(view) || groupHeader(view), '报名成功，但未回到美食列表');
}

function scanRound(initialView) {
    const reviewed = new Set();
    const signatures = new Map();
    let view = initialView;
    for (let step = 0; step < 260; step += 1) {
        var footer = listFooter(view);
        var visible = cards(view, null);
        if (dryRun) noteUnresolved(view, visible, null);
        if (step % 12 === 0) report('扫描中：第 ' + (step + 1) + ' 屏，当前读到 ' + visible.length + ' 个金额');
        var candidate = visible.find(assess);
        if (candidate) {
            view = enroll(candidate, false);
            if (reviewHandoff) return null;
            if (groupHeader(view)) view = closeGroup(view);
            continue;
        }
        var group = visible.find(item => item.title && item.related && !reviewed.has(storeKey(item) + ':' + item.related.text));
        if (group) {
            tap(group.related);
            var expanded = waitFor(page => groupHeader(page) && loadedActivities(page), '相似活动弹窗未载入活动');
            var nested = cards(expanded, groupHeader(expanded));
            if (dryRun) noteUnresolved(expanded, nested, groupHeader(expanded));
            var groupCount = Number((group.related.text.match(/[0-9]+/) || [])[0]);
            if (!Number.isFinite(groupCount) || nested.filter(item => item.title).length < groupCount) {
                if (!dryRun) throw new Error('相似活动数量未能核对：' + group.title);
                var groupKey = '相似活动:' + storeKey(group);
                if (!scanUnresolved.has(groupKey)) report('待核对：相似活动数量未能核对：' + group.title);
                scanUnresolved.add(groupKey);
            }
            var next = nested.find(assess);
            if (next) {
                view = enroll(next, true);
                if (reviewHandoff) return null;
                if (groupHeader(view)) view = closeGroup(view);
            } else {
                reviewed.add(storeKey(group) + ':' + group.related.text);
                view = closeGroup(expanded);
            }
            continue;
        }
        if (footer) {
            if (!dryRun && visible.some(item => item.button && item.value >= threshold && !item.title)) throw new Error('已到底，但仍有无法识别的候选活动');
            report('列表终点：' + footer.text);
            return view;
        }
        var signature = visible.map(item => storeKey(item) + ':' + Math.round((item.button ? item.button.y : 0) / 25)).join('|');
        var count = (signatures.get(signature) || 0) + 1;
        signatures.set(signature, count);
        if (count > 5) throw new Error('页面停止推进，但未看到「暂无更多活动」');
        act('滚动美食列表', () => swipe(Math.round(screenWidth * 0.53), Math.round(screenHeight * 0.84), Math.round(screenWidth * 0.53), Math.round(screenHeight * 0.49), 720));
        view = waitFor(readyList, '滚动后美食列表尚未就绪');
    }
    throw new Error('达到本轮扫描步数上限，未确认列表末尾');
}

function run(mode) {
    lastStep = null;
    dryRun = mode === 0;
    if (!dryRun && storage.contains('pending')) {
        throw new Error('请先人工核对上次提交：' + storage.get('pending'));
    }
    if (!auto.service) throw new Error('请先在 AutoX.js 开启无障碍服务');
    checkNetwork();
    if (typeof paddle === 'undefined' || typeof paddle.ocr !== 'function') throw new Error('当前 AutoX.js 没有可用的 Paddle 文字识别模块');
    report('准备申请屏幕擷取权限');
    captureRequested = true;
    if (!requestScreenCapture(false)) throw new Error('需要授予整个屏幕的录屏权限，图片只在手机本地识别');
    if (typeof paddle.initOcrWithConfig === 'function') paddle.initOcrWithConfig({ imageSize: 640, cpuThreadNum: 4 });
    report('屏幕擷取已获准，开始识别大众点评');
    act('打开大众点评', () => app.launchPackage(appPackage), false);
    let view = waitFor(page => readyHome(page) || readyList(page), '请先打开大众点评首页或美食列表');
    if (!isHome(view)) {
        press(72, 195, '回首页');
        view = waitFor(readyHome, '启动检查时未回到首页');
    }
    const profile = view.find(node => node.x > 815 && node.y > 2150 && /个人|個人/.test(node.text));
    tap(profile);
    const profileView = waitFor(isProfile, '未确认大众点评已登录，请检查个人页');
    tap(profileView.find(node => node.x < 250 && node.y > 2150 && /首页|首頁/.test(node.text)));
    view = waitFor(readyHome, '个人页检查后未回到首页');
    report('网络可用，已看到个人主页，开始' + (dryRun ? '只扫描' : '正式报名'));
    for (let round = 1; round <= maxRounds; round += 1) {
        var before = submitted;
        var candidatesBefore = scanCandidates.size;
        report('第 ' + round + ' 轮：从首页重进并选择美食');
        view = scanRound(reopen(view));
        if (reviewHandoff) return;
        var added = submitted - before;
        var newCandidates = scanCandidates.size - candidatesBefore;
        var changed = dryRun ? newCandidates > 0 : added > 0;
        report('第 ' + round + ' 轮完成，' + (dryRun ? '新增候选 ' + newCandidates : '新增报名 ' + added) + ' 项');
        if (round >= 2 && !changed) {
            report(dryRun ? '只扫描完成：' + scanSummary() : '复查完成，本次共报名 ' + submitted + ' 项');
            toast(dryRun ? '只扫描完成，未提交报名' : '复查完成，成功报名 ' + submitted + ' 项');
            return;
        }
    }
    throw new Error((dryRun ? '最后一轮仍发现新的候选' : '最后一轮仍有新增报名') + '，已到本次复查上限');
}

function stopOwnCapture() {
    if (!captureRequested) return '';
    captureRequested = false;
    try {
        if (typeof runtime !== 'undefined' && runtime.images && typeof runtime.images.stopScreenCapturer === 'function') {
            runtime.images.stopScreenCapturer();
        } else if (typeof images !== 'undefined' && typeof images.stopScreenCapture === 'function') {
            images.stopScreenCapture();
        } else {
            throw new Error('没有停止屏幕分享的接口');
        }
        report('已请求系统停止本次屏幕分享');
        return '';
    } catch (error) {
        report('无法自动停止屏幕分享：' + error.message);
        return '无法自动确认屏幕分享已停止。如状态栏仍显示分享，请点「停止分享」。';
    }
}

function showLauncher() {
    const layout = new android.widget.LinearLayout(activity);
    layout.setOrientation(android.widget.LinearLayout.VERTICAL);
    const density = activity.getResources().getDisplayMetrics().density;
    const padding = Math.round(24 * density);
    layout.setPadding(padding, padding, padding, padding);
    const title = new android.widget.TextView(activity);
    title.setText('大众点评免费试');
    title.setTextSize(24);
    layout.addView(title);
    const status = new android.widget.TextView(activity);
    status.setPadding(0, padding, 0, padding);
    status.setText('美食｜价值 ≥ ¥150。\n每步等待 4–10 秒，页面未就绪就停止。遇到「写评价点亮橙V」会在评价页暂停，不填正文或发布。');
    layout.addView(status);
    const buttons = [];
    function addButton(label, action) {
        const button = new android.widget.Button(activity);
        button.setText(label);
        button.setOnClickListener(new android.view.View.OnClickListener({ onClick: action }));
        layout.addView(button);
        buttons.push(button);
    }
    function begin(mode) {
        buttons.forEach(button => button.setEnabled(false));
        status.setText('运行中，请保持手机解锁并让大众点评位于前台。');
        threads.start(function () {
            let message;
            try {
                submitted = 0;
                captureRequested = false;
                diagnostics = '';
                reviewEditorOpen = false;
                reviewHandoff = '';
                finished.clear();
                skipped.clear();
                scanCandidates.clear();
                scanUnresolved.clear();
                run(mode);
                message = reviewHandoff ? '已暂停在「' + reviewHandoff + '」评价页。请自行填写正文。\n本轮已确认报名 ' + submitted + ' 项。'
                    : mode === 0 ? '只扫描完成，没有提交报名。\n' + scanSummary() : '复查完成，成功报名 ' + submitted + ' 项。';
            } catch (error) {
                message = '未完成：' + error.message + '；已确认报名 ' + submitted + ' 项。';
                if (mode === 0) message += '\n' + scanSummary();
                if (diagnostics) message += '\n' + diagnostics;
                report(message);
                toast(message);
            } finally {
                const captureWarning = stopOwnCapture();
                if (captureWarning) {
                    message += '\n' + captureWarning;
                    toast(captureWarning);
                }
                ui.run(function () {
                    status.setText(message);
                    buttons.forEach(button => button.setEnabled(true));
                    if (!reviewEditorOpen && currentPackage() === appPackage) {
                        try {
                            activity.getSystemService(android.content.Context.ACTIVITY_SERVICE).moveTaskToFront(activity.getTaskId(), 0);
                        } catch (error) { report('请切回脚本查看结果：' + error.message); }
                    }
                });
            }
        });
    }
    addButton('只扫描，不报名', () => begin(0));
    addButton('开始报名（遇橙V提示暂停）', () => begin(1));
    addButton('已人工核对，清除上次待确认标记', function () {
        if (!storage.contains('pending')) {
            status.setText('当前没有待确认的提交。');
            return;
        }
        new android.app.AlertDialog.Builder(activity)
            .setTitle('请核对上次报名')
            .setMessage(storage.get('pending'))
            .setNegativeButton('取消', null)
            .setPositiveButton('已人工核对', new android.content.DialogInterface.OnClickListener({ onClick: function () {
                storage.remove('pending');
                status.setText('已清除待确认标记。');
            } })).show();
    });
    activity.setContentView(layout);
}

if (typeof activity !== 'undefined') showLauncher();
