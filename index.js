/**
 * ST Char Manager · 角色卡管理
 * 角色卡浏览 / 搜索 / 收藏 / 分类筛选 / 一键切换 / 详情预览 / 导出备份
 * https://github.com/idx425/st-char-manager
 * License: MIT
 */
(() => {
    'use strict';

    const MODULE = 'st_char_manager';
    const EXT_NAME = 'st-char-manager';
    const VERSION = '1.0.0';
    const REPO_PATH = 'idx425/st-char-manager';

    function getCtx() {
        try {
            return SillyTavern.getContext();
        } catch {
            return null;
        }
    }

    jQuery(async () => {
        const ctx = getCtx();
        if (!ctx) {
            console.error('[角色卡管理] 无法获取 SillyTavern context，扩展未加载（酒馆版本过旧？）');
            return;
        }

        /* ---------------- 设置存取 ---------------- */
        if (!ctx.extensionSettings[MODULE] || typeof ctx.extensionSettings[MODULE] !== 'object') {
            ctx.extensionSettings[MODULE] = {};
        }
        const settings = ctx.extensionSettings[MODULE];
        if (!Array.isArray(settings.favs)) settings.favs = [];
        if (!Array.isArray(settings.recent)) settings.recent = [];
        if (!['recent', 'name', 'added'].includes(settings.sort)) settings.sort = 'recent';
        const save = () => ctx.saveSettingsDebounced();

        /* ---------------- 数据读取（每次都取最新 context，避免快照过期） ---------------- */
        // context 里的 characterId 是调用时的快照值，缓存旧 ctx 会读到过期的当前角色
        // deletedAvatars：后端已删除但前端角色列表要刷新页面才同步，先在本地过滤掉
        const deletedAvatars = new Set();
        const chars = () => {
            const c = getCtx();
            const list = (c && Array.isArray(c.characters)) ? c.characters : [];
            return deletedAvatars.size ? list.filter((ch) => ch && !deletedAvatars.has(ch.avatar)) : list;
        };
        const curAvatar = () => {
            const c = getCtx();
            if (!c || c.characterId === undefined || c.characterId === null || c.characterId === '') return null;
            const ch = c.characters && c.characters[c.characterId];
            return ch ? ch.avatar : null;
        };

        const isFav = (ch) => settings.favs.includes(ch.avatar) || !!ch.fav || !!(ch.data && ch.data.extensions && ch.data.extensions.fav);
        const charName = (ch) => String(ch.name || (ch.data && ch.data.name) || '未命名');
        const charCreator = (ch) => String((ch.data && ch.data.creator) || '');
        const charVersion = (ch) => String((ch.data && ch.data.character_version) || '');
        const charDesc = (ch) => String(ch.description || (ch.data && ch.data.description) || '');
        const charFirstMes = (ch) => String(ch.first_mes || (ch.data && ch.data.first_mes) || '');
        const lastChatTs = (ch) => Number(ch.date_last_chat || 0);
        const addedTs = (ch) => Number(ch.date_added || 0);

        function avatarUrl(ch) {
            const c = getCtx();
            try {
                if (c && typeof c.getThumbnailUrl === 'function') return c.getThumbnailUrl('avatar', ch.avatar);
            } catch { /* 走手动拼接 */ }
            return '/thumbnail?type=avatar&file=' + encodeURIComponent(ch.avatar);
        }

        function charTags(ch) {
            const c = getCtx();
            if (!c || !c.tagMap || !Array.isArray(c.tags)) return [];
            const ids = c.tagMap[ch.avatar];
            if (!Array.isArray(ids)) return [];
            return ids.map((id) => c.tags.find((t) => t && t.id === id)).filter(Boolean);
        }

        function allTags() {
            const c = getCtx();
            if (!c || !Array.isArray(c.tags) || !c.tagMap) return [];
            const used = new Set();
            for (const ch of chars()) {
                const ids = c.tagMap[ch.avatar];
                if (Array.isArray(ids)) ids.forEach((id) => used.add(id));
            }
            return c.tags.filter((t) => t && used.has(t.id));
        }

        function recordRecent(avatar) {
            if (!avatar) return;
            settings.recent = [avatar, ...settings.recent.filter((a) => a !== avatar)].slice(0, 30);
            save();
        }

        /* ---------------- 核心：切换角色 ---------------- */
        async function switchToChar(ch) {
            const c = getCtx();
            const idx = c.characters.findIndex((x) => x && x.avatar === ch.avatar);
            if (idx < 0) {
                toastr.error('角色列表里找不到「' + charName(ch) + '」，试试点右上角刷新', '角色卡管理');
                return false;
            }
            try {
                if (typeof c.selectCharacterById === 'function') {
                    await c.selectCharacterById(idx);
                } else {
                    // 旧版本 context 没有导出 selectCharacterById 时，退回模拟点击角色列表
                    const el = $(`#rm_print_characters_block .character_select[chid="${idx}"]`);
                    if (!el.length) throw new Error('当前酒馆版本不支持程序化切换角色');
                    el.trigger('click');
                }
                recordRecent(ch.avatar);
                toastr.success('已切换到「' + charName(ch) + '」', '角色卡管理');
                return true;
            } catch (err) {
                console.error('[角色卡管理]', err);
                toastr.error(String(err && err.message || err), '切换失败');
                return false;
            }
        }

        /* ---------------- 更新检查（一键更新，与 API 快切同款机制） ---------------- */
        let updGlobal = false;
        let updState = 'idle';

        function setUpdateState(s) {
            updState = s;
            const btn = $('#ccm_update_btn');
            if (!btn.length) return;
            const map = {
                idle: '<i class="fa-solid fa-satellite-dish"></i> 检查更新',
                checking: '<i class="fa-solid fa-circle-notch fa-spin"></i> 检测中',
                latest: '<i class="fa-solid fa-circle-check"></i> 已最新',
                available: '<i class="fa-solid fa-cloud-arrow-down"></i> 新版本·点击更新',
                updating: '<i class="fa-solid fa-circle-notch fa-spin"></i> 更新中',
                updated: '<i class="fa-solid fa-rotate-right"></i> 刷新生效',
            };
            btn.html(map[s] || map.idle);
            btn.toggleClass('ccm-update-avail', s === 'available' || s === 'updated');
        }

        let scopeCache;

        function fetchTimeout(url, opts, ms) {
            const ac = new AbortController();
            const t = setTimeout(() => ac.abort(), ms || 8000);
            return fetch(url, Object.assign({}, opts, { signal: ac.signal })).finally(() => clearTimeout(t));
        }

        async function resolveInstallScope() {
            if (scopeCache !== undefined) return scopeCache;
            try {
                const res = await fetchTimeout('/api/extensions/discover', {
                    method: 'GET',
                    headers: ctx.getRequestHeaders(),
                });
                if (res.ok) {
                    const list = await res.json();
                    const hit = Array.isArray(list) && list.find((e) =>
                        e && (e.name === `third-party/${EXT_NAME}` || e.name === EXT_NAME));
                    if (hit) {
                        scopeCache = String(hit.type).toLowerCase() === 'global';
                        return scopeCache;
                    }
                }
            } catch { /* 后端不支持 discover 时走盲测 */ }
            scopeCache = null;
            return null;
        }

        function cmpVer(a, b) {
            const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
            for (let i = 0; i < 3; i++) {
                const d = (pa[i] || 0) - (pb[i] || 0);
                if (d) return d;
            }
            return 0;
        }

        async function checkRemoteManifest() {
            const urls = [
                `https://raw.githubusercontent.com/${REPO_PATH}/main/manifest.json`,
                `https://cdn.jsdelivr.net/gh/${REPO_PATH}@main/manifest.json`,
                `https://fastly.jsdelivr.net/gh/${REPO_PATH}@main/manifest.json`,
            ];
            for (const u of urls) {
                try {
                    const res = await fetchTimeout(u, { cache: 'no-cache' }, 6000);
                    if (!res.ok) continue;
                    const m = await res.json();
                    if (m && m.version) return m.version;
                } catch { /* 换下一个源 */ }
            }
            return null;
        }

        let updateNotified = false;

        function notifyUpdate(remoteVer, force) {
            if (updateNotified && !force) return;
            updateNotified = true;
            const label = remoteVer ? ' v' + remoteVer : '';
            toastr.info(
                '检测到新版本' + label + '，点击此通知立即更新（或在插件面板顶部点更新按钮）',
                '角色卡管理 · 有更新',
                { timeOut: 12000, extendedTimeOut: 4000, onclick: () => doUpdate() },
            );
        }

        async function checkUpdate(silent) {
            if (updState === 'checking' || updState === 'updating') return;
            setUpdateState('checking');
            const scope = await resolveInstallScope();
            const tries = scope === null ? [true, false] : [scope];
            let backendErr = null;
            for (const g of tries) {
                try {
                    const res = await fetchTimeout('/api/extensions/version', {
                        method: 'POST',
                        headers: ctx.getRequestHeaders(),
                        body: JSON.stringify({ extensionName: EXT_NAME, global: g }),
                    });
                    if (!res.ok) {
                        backendErr = await res.text().catch(() => 'HTTP ' + res.status);
                        continue;
                    }
                    const data = await res.json();
                    updGlobal = g;
                    if (data.isUpToDate === false) {
                        setUpdateState('available');
                        notifyUpdate('', !silent);
                    } else {
                        setUpdateState('latest');
                        if (!silent) toastr.success('已是最新版本 v' + VERSION, '角色卡管理');
                    }
                    return;
                } catch (e) { backendErr = String(e && e.message || e); }
            }
            const remoteVer = await checkRemoteManifest();
            if (remoteVer && cmpVer(remoteVer, VERSION) > 0) {
                if (scope !== null) updGlobal = scope;
                setUpdateState('available');
                notifyUpdate(remoteVer, !silent);
                return;
            }
            if (remoteVer) {
                setUpdateState('latest');
                if (!silent) toastr.success('已是最新版本 v' + VERSION, '角色卡管理');
                return;
            }
            setUpdateState('idle');
            if (!silent) {
                const hint = /not found/i.test(backendErr || '')
                    ? '后端找不到扩展目录（可能安装方式不受支持）'
                    : '后端无法连接 GitHub（如在国内请开启代理后重试）';
                toastr.warning('无法检查更新：' + hint, '角色卡管理');
            }
        }

        async function doUpdate() {
            if (updState === 'updating') return;
            setUpdateState('updating');
            const scope = await resolveInstallScope();
            const tries = scope === null ? [updGlobal, !updGlobal] : [scope];
            let lastErr = null;
            for (const g of tries) {
                try {
                    const res = await fetchTimeout('/api/extensions/update', {
                        method: 'POST',
                        headers: ctx.getRequestHeaders(),
                        body: JSON.stringify({ extensionName: EXT_NAME, global: g }),
                    }, 30000);
                    if (!res.ok) {
                        lastErr = await res.text().catch(() => 'HTTP ' + res.status);
                        continue;
                    }
                    setUpdateState('updated');
                    if (confirm('更新完成！立即刷新页面使新版本生效？')) {
                        location.reload();
                    }
                    return;
                } catch (e) { lastErr = String(e && e.message || e); }
            }
            setUpdateState('available');
            let hint = lastErr || '未知错误';
            if (/metadata is missing/i.test(hint)) {
                hint = '扩展缺少安装来源信息，请在「管理扩展」里删除后，用「安装扩展」粘贴仓库链接重装一次（收藏等数据不会丢失）';
            } else if (/not found/i.test(hint)) {
                hint = '后端找不到扩展目录，请删除后用「安装扩展」重装一次（数据不会丢失）';
            } else if (/network|fetch|timeout|abort|connect/i.test(hint)) {
                hint = '无法连接 GitHub 下载更新（如在国内请开启代理后重试）';
            }
            toastr.error(hint, '更新失败');
        }

        /* ---------------- 通用弹窗（拦截冒泡，防止酒馆误关扩展面板） ---------------- */
        function makeOverlay(id, boxHtml) {
            $('#' + id).remove();
            const overlay = $(`<div id="${id}" class="ccm-overlay"></div>`).append(boxHtml);
            $('body').append(overlay);
            const close = () => { overlay.remove(); $(document).off('keydown.' + id); };
            // 弹窗挂在 body 上，点击若冒泡到 document，酒馆会判定"点击了面板外部"
            // 而关闭整个扩展设置面板 —— 全部拦截
            overlay.on('pointerdown pointerup mousedown mouseup click touchstart touchend', (e) => {
                e.stopPropagation();
                if (e.type === 'pointerdown' && e.target === overlay[0]) close();
            });
            $(document).on('keydown.' + id, (e) => {
                // 多层弹窗叠加时（详情叠在管理器上），Esc 只关最上层
                if (e.key === 'Escape' && $('.ccm-overlay').last().attr('id') === id) close();
            });
            overlay.find('.ccm-modal-close').on('click', close);
            return { overlay, close };
        }

        /* ---------------- 详情弹窗 ---------------- */
        function escapeText(s) {
            return String(s || '');
        }

        function openDetail(ch) {
            const tags = charTags(ch);
            const box = $(`
                <div class="ccm-modal-box ccm-detail-box">
                  <div class="ccm-modal-head">
                    <span><i class="fa-solid fa-id-card"></i> CHAR·DETAIL<i class="ccm-blink">▊</i></span>
                    <i class="fa-solid fa-xmark ccm-modal-close" title="关闭"></i>
                  </div>
                  <div class="ccm-detail-body">
                    <div class="ccm-detail-top">
                      <img class="ccm-detail-avatar" alt="">
                      <div class="ccm-detail-info">
                        <div class="ccm-detail-name"></div>
                        <div class="ccm-detail-sub"></div>
                        <div class="ccm-detail-tags"></div>
                        <div class="ccm-detail-stats"></div>
                      </div>
                    </div>
                    <div class="ccm-detail-btns"></div>
                    <div class="ccm-detail-section" data-sec="desc">
                      <div class="ccm-detail-sec-title">角色描述</div>
                      <div class="ccm-detail-sec-text"></div>
                    </div>
                    <div class="ccm-detail-section" data-sec="first">
                      <div class="ccm-detail-sec-title">开场白</div>
                      <div class="ccm-detail-sec-text"></div>
                    </div>
                  </div>
                </div>`);
            const { close } = makeOverlay('ccm_detail_modal', box);

            const img = box.find('.ccm-detail-avatar');
            img.attr('src', avatarUrl(ch)).on('error', function () {
                $(this).attr('src', '/characters/' + encodeURIComponent(ch.avatar));
            });
            box.find('.ccm-detail-name').text(charName(ch));
            const subParts = [];
            if (charCreator(ch)) subParts.push('作者 ' + charCreator(ch));
            if (charVersion(ch)) subParts.push('v' + charVersion(ch));
            if (lastChatTs(ch)) subParts.push('最近聊天 ' + new Date(lastChatTs(ch)).toLocaleDateString());
            box.find('.ccm-detail-sub').text(subParts.join(' · ') || '暂无附加信息');

            const tagBox = box.find('.ccm-detail-tags');
            if (tags.length) {
                tags.forEach((t) => $('<span class="ccm-tag"></span>').text(t.name).appendTo(tagBox));
            } else {
                tagBox.hide();
            }

            const desc = charDesc(ch), first = charFirstMes(ch);
            box.find('.ccm-detail-stats').text(`描述 ${desc.length} 字 · 开场白 ${first.length} 字`);
            const secs = box.find('.ccm-detail-section');
            secs.filter('[data-sec="desc"]').find('.ccm-detail-sec-text').text(escapeText(desc) || '（空）');
            secs.filter('[data-sec="first"]').find('.ccm-detail-sec-text').text(escapeText(first) || '（空）');

            const btns = box.find('.ccm-detail-btns');
            $('<button class="menu_button ccm-btn ccm-btn-primary"><i class="fa-solid fa-comment"></i> 开始聊天</button>')
                .on('click', async () => { close(); closeManager(); await switchToChar(ch); }).appendTo(btns);
            $('<button class="menu_button ccm-btn"><i class="fa-solid fa-star"></i> 收藏</button>')
                .each(function () { updateFavBtn($(this), ch); })
                .on('click', function () { toggleFav(ch); updateFavBtn($(this), ch); renderGrid(); }).appendTo(btns);
            $('<button class="menu_button ccm-btn" title="下载角色卡 PNG 文件（含完整卡片数据，可导入任何酒馆）"><i class="fa-solid fa-download"></i> 导出</button>')
                .on('click', () => exportCard(ch)).appendTo(btns);
            $('<button class="menu_button ccm-btn" title="创建一份副本"><i class="fa-solid fa-copy"></i> 复制</button>')
                .on('click', () => duplicateCard(ch)).appendTo(btns);
            $('<button class="menu_button ccm-btn ccm-danger" title="删除角色卡"><i class="fa-solid fa-trash"></i> 删除</button>')
                .on('click', () => deleteCard(ch, close)).appendTo(btns);
        }

        function updateFavBtn(btn, ch) {
            const on = settings.favs.includes(ch.avatar);
            btn.html(on
                ? '<i class="fa-solid fa-star"></i> 已收藏'
                : '<i class="fa-regular fa-star"></i> 收藏');
            btn.toggleClass('ccm-fav-on', on);
        }

        function toggleFav(ch) {
            if (settings.favs.includes(ch.avatar)) {
                settings.favs = settings.favs.filter((a) => a !== ch.avatar);
            } else {
                settings.favs.push(ch.avatar);
            }
            save();
        }

        /* ---------------- 卡片操作：导出 / 复制 / 删除 ---------------- */
        function exportCard(ch) {
            // /characters/<file> 就是含完整嵌入数据的 PNG 角色卡，直接下载即可导入任何酒馆
            const a = document.createElement('a');
            a.href = '/characters/' + encodeURIComponent(ch.avatar);
            a.download = ch.avatar;
            document.body.appendChild(a);
            a.click();
            a.remove();
            toastr.success('已开始下载「' + charName(ch) + '」的角色卡 PNG', '角色卡管理');
        }

        async function duplicateCard(ch) {
            if (!confirm('创建「' + charName(ch) + '」的副本？')) return;
            try {
                const res = await fetchTimeout('/api/characters/duplicate', {
                    method: 'POST',
                    headers: ctx.getRequestHeaders(),
                    body: JSON.stringify({ avatar_url: ch.avatar }),
                }, 15000);
                if (!res.ok) throw new Error('HTTP ' + res.status);
                toastr.success('副本已创建，刷新页面后可见', '角色卡管理');
                if (confirm('副本已创建，需要刷新页面才会出现在列表里。现在刷新吗？')) location.reload();
            } catch (err) {
                console.error('[角色卡管理]', err);
                toastr.error('复制失败：' + String(err && err.message || err), '角色卡管理');
            }
        }

        async function deleteCard(ch, closeDetail) {
            if (!confirm('确定删除角色卡「' + charName(ch) + '」？此操作不可恢复！')) return;
            const delChats = confirm('是否连同该角色的所有聊天记录一起删除？\n\n「确定」= 一起删除\n「取消」= 保留聊天记录');
            if (!confirm('最后确认：删除「' + charName(ch) + '」' + (delChats ? '及其全部聊天记录' : '（保留聊天记录）') + '？')) return;
            try {
                const res = await fetchTimeout('/api/characters/delete', {
                    method: 'POST',
                    headers: ctx.getRequestHeaders(),
                    body: JSON.stringify({ avatar_url: ch.avatar, delete_chats: delChats }),
                }, 20000);
                if (!res.ok) throw new Error('HTTP ' + res.status);
                deletedAvatars.add(ch.avatar);
                settings.favs = settings.favs.filter((a) => a !== ch.avatar);
                settings.recent = settings.recent.filter((a) => a !== ch.avatar);
                save();
                if (closeDetail) closeDetail();
                toastr.success('已删除「' + charName(ch) + '」', '角色卡管理');
                if (confirm('删除成功，需要刷新页面同步角色列表。现在刷新吗？')) location.reload();
                else renderGrid();
            } catch (err) {
                console.error('[角色卡管理]', err);
                toastr.error('删除失败：' + String(err && err.message || err), '角色卡管理');
            }
        }

        /* ---------------- 管理器主界面 ---------------- */
        let filterMode = 'all';   // all | fav | recent
        let filterTag = null;     // tag id
        let searchText = '';

        function closeManager() {
            $('#ccm_manager_modal').remove();
            $(document).off('keydown.ccm_manager_modal');
        }

        function sortLabel() {
            return { recent: '最近聊天', name: '名称', added: '添加时间' }[settings.sort] || '最近聊天';
        }

        function filteredChars() {
            let list = chars().filter(Boolean);
            if (filterMode === 'fav') list = list.filter(isFav);
            if (filterMode === 'recent') {
                const order = settings.recent;
                list = list.filter((ch) => order.includes(ch.avatar));
                list.sort((a, b) => order.indexOf(a.avatar) - order.indexOf(b.avatar));
            }
            if (filterTag) {
                list = list.filter((ch) => charTags(ch).some((t) => t.id === filterTag));
            }
            const q = searchText.trim().toLowerCase();
            if (q) {
                list = list.filter((ch) =>
                    charName(ch).toLowerCase().includes(q) ||
                    charCreator(ch).toLowerCase().includes(q) ||
                    charDesc(ch).toLowerCase().includes(q) ||
                    charTags(ch).some((t) => String(t.name).toLowerCase().includes(q)));
            }
            if (filterMode !== 'recent') {
                if (settings.sort === 'name') {
                    list.sort((a, b) => charName(a).localeCompare(charName(b), 'zh'));
                } else if (settings.sort === 'added') {
                    list.sort((a, b) => addedTs(b) - addedTs(a));
                } else {
                    list.sort((a, b) => lastChatTs(b) - lastChatTs(a));
                }
            }
            return list;
        }

        function charTile(ch) {
            const active = curAvatar() === ch.avatar;
            const tile = $('<div class="ccm-tile" tabindex="0"></div>').toggleClass('ccm-active', active);

            const imgWrap = $('<div class="ccm-tile-img"></div>');
            const img = $('<img loading="lazy" alt="">').attr('src', avatarUrl(ch));
            img.on('error', function () {
                if ($(this).data('fb')) return;
                $(this).data('fb', 1).attr('src', '/characters/' + encodeURIComponent(ch.avatar));
            });
            imgWrap.append(img);
            if (active) imgWrap.append($('<span class="ccm-tile-live">当前</span>'));

            const star = $('<i class="ccm-tile-star fa-star"></i>')
                .addClass(isFav(ch) ? 'fa-solid ccm-star-on' : 'fa-regular')
                .attr('title', '收藏/取消收藏')
                .on('click', (e) => {
                    e.stopPropagation();
                    toggleFav(ch);
                    renderGrid();
                });
            imgWrap.append(star);

            const info = $('<i class="ccm-tile-info fa-solid fa-circle-info"></i>')
                .attr('title', '查看详情')
                .on('click', (e) => { e.stopPropagation(); openDetail(ch); });
            imgWrap.append(info);

            const nameBar = $('<div class="ccm-tile-name"></div>').text(charName(ch));
            tile.append(imgWrap, nameBar);

            tile.on('click', async () => {
                closeManager();
                await switchToChar(ch);
            });
            tile.on('keydown', (e) => { if (e.key === 'Enter') tile.trigger('click'); });
            return tile;
        }

        function renderGrid() {
            const grid = $('#ccm_grid');
            if (!grid.length) return;
            grid.empty();
            const list = filteredChars();
            $('#ccm_count').text(list.length + ' / ' + chars().filter(Boolean).length);
            if (!list.length) {
                grid.append($('<div class="ccm-empty">没有匹配的角色卡</div>'));
                return;
            }
            list.forEach((ch) => grid.append(charTile(ch)));
        }

        function renderFilters() {
            const modes = [
                { key: 'all', icon: 'fa-layer-group', label: '全部' },
                { key: 'fav', icon: 'fa-star', label: '收藏' },
                { key: 'recent', icon: 'fa-clock-rotate-left', label: '最近' },
            ];
            const modeBox = $('#ccm_modes').empty();
            for (const m of modes) {
                $(`<button type="button" class="ccm-fchip"><i class="fa-solid ${m.icon}"></i> ${m.label}</button>`)
                    .toggleClass('ccm-fchip-on', filterMode === m.key)
                    .on('click', () => { filterMode = m.key; renderFilters(); renderGrid(); })
                    .appendTo(modeBox);
            }
            $(`<button type="button" class="ccm-fchip ccm-fchip-sort" title="点击切换排序方式"><i class="fa-solid fa-arrow-down-wide-short"></i> ${sortLabel()}</button>`)
                .on('click', () => {
                    const order = ['recent', 'name', 'added'];
                    settings.sort = order[(order.indexOf(settings.sort) + 1) % order.length];
                    save();
                    renderFilters();
                    renderGrid();
                })
                .appendTo(modeBox);

            const tagBox = $('#ccm_tagbar').empty();
            const tags = allTags();
            if (!tags.length) { tagBox.hide(); return; }
            tagBox.show();
            for (const t of tags) {
                $('<button type="button" class="ccm-tchip"></button>').text(t.name)
                    .toggleClass('ccm-tchip-on', filterTag === t.id)
                    .on('click', () => {
                        filterTag = (filterTag === t.id) ? null : t.id;
                        renderFilters();
                        renderGrid();
                    })
                    .appendTo(tagBox);
            }
        }

        function openManager() {
            const box = $(`
                <div class="ccm-modal-box ccm-manager-box">
                  <div class="ccm-modal-head">
                    <span><i class="fa-solid fa-address-book"></i> CHAR·MANAGER <span class="ccm-sys-ver">v${VERSION}</span><i class="ccm-blink">▊</i></span>
                    <span class="ccm-head-tools">
                      <span id="ccm_count" class="ccm-count"></span>
                      <i class="fa-solid fa-rotate ccm-head-btn" id="ccm_refresh" title="刷新列表"></i>
                      <i class="fa-solid fa-xmark ccm-modal-close" title="关闭"></i>
                    </span>
                  </div>
                  <input id="ccm_search" class="text_pole ccm-search" placeholder="搜索名称 / 作者 / 标签 / 描述…" autocomplete="off">
                  <div id="ccm_modes" class="ccm-modes"></div>
                  <div id="ccm_tagbar" class="ccm-tagbar"></div>
                  <div id="ccm_grid" class="ccm-grid"></div>
                </div>`);
            makeOverlay('ccm_manager_modal', box);
            $('#ccm_search').val(searchText).on('input', function () {
                searchText = this.value;
                renderGrid();
            });
            $('#ccm_refresh').on('click', () => {
                renderFilters();
                renderGrid();
                toastr.info('列表已刷新', '角色卡管理');
            });
            renderFilters();
            renderGrid();
        }

        /* ---------------- 魔棒菜单入口 ---------------- */
        function setupWandMenu() {
            const menuItem = $(
                '<div id="ccm_wand_item" class="list-group-item flex-container flexGap5 interactable" tabindex="0">' +
                '<i class="fa-solid fa-address-book"></i><span>角色卡管理</span></div>'
            );
            $('#extensionsMenu').append(menuItem);
            menuItem.on('click', () => openManager());
        }

        /* ---------------- 斜杠命令 ---------------- */
        function setupSlashCommand() {
            try {
                const { SlashCommandParser, SlashCommand, SlashCommandArgument, ARGUMENT_TYPE } = ctx;
                if (!SlashCommandParser || !SlashCommand) return;
                SlashCommandParser.addCommandObject(SlashCommand.fromProps({
                    name: 'charman',
                    aliases: ['ccm'],
                    helpString: '打开角色卡管理器。',
                    callback: async () => { openManager(); return ''; },
                }));
                SlashCommandParser.addCommandObject(SlashCommand.fromProps({
                    name: 'charswitch',
                    aliases: ['ccs'],
                    helpString: '按名称切换角色，例如 /charswitch 角色名；不带参数列出全部角色名。',
                    unnamedArgumentList: SlashCommandArgument ? [SlashCommandArgument.fromProps({
                        description: '角色名称',
                        typeList: ARGUMENT_TYPE ? [ARGUMENT_TYPE.STRING] : undefined,
                        isRequired: false,
                    })] : [],
                    callback: async (_args, value) => {
                        const name = String(value || '').trim();
                        if (!name) {
                            const names = chars().filter(Boolean).map(charName).join('、') || '（空）';
                            toastr.info(names, '全部角色');
                            return names;
                        }
                        const q = name.toLowerCase();
                        const list = chars().filter(Boolean);
                        const hit = list.find((ch) => charName(ch).toLowerCase() === q)
                            || list.find((ch) => charName(ch).toLowerCase().includes(q));
                        if (!hit) { toastr.warning('没有找到角色：' + name); return ''; }
                        await switchToChar(hit);
                        return charName(hit);
                    },
                }));
            } catch (e) {
                console.warn('[角色卡管理] 斜杠命令注册失败（不影响其他功能）', e);
            }
        }

        /* ---------------- 最近使用记录（监听聊天切换事件） ---------------- */
        function setupRecentTracking() {
            try {
                const c = getCtx();
                if (c && c.eventSource && c.event_types && c.event_types.CHAT_CHANGED) {
                    c.eventSource.on(c.event_types.CHAT_CHANGED, () => {
                        const a = curAvatar();
                        if (a) recordRecent(a);
                    });
                }
            } catch (e) {
                console.warn('[角色卡管理] 最近使用记录不可用', e);
            }
        }

        /* ---------------- 设置面板挂载 ---------------- */
        const html = `
        <div class="ccm-settings">
          <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
              <b><i class="fa-solid fa-address-book ccm-grad-icon"></i>&nbsp;角色卡管理</b>
              <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
              <div class="ccm-sys-bar">
                <span class="ccm-sys-id">CHAR·MANAGER</span>
                <span class="ccm-sys-ver">v${VERSION}</span>
                <i class="ccm-blink">▊</i>
                <span class="ccm-sys-spacer"></span>
                <button id="ccm_update_btn" class="menu_button ccm-btn"><i class="fa-solid fa-satellite-dish"></i> 检查更新</button>
              </div>
              <button id="ccm_open_btn" class="menu_button ccm-btn ccm-btn-primary ccm-open-btn"><i class="fa-solid fa-address-book"></i> 打开角色卡管理器</button>
              <small class="ccm-note">快捷入口：输入框旁魔棒菜单 → 角色卡管理，或命令 /charman；按名称切换：/charswitch 角色名。收藏与最近记录存于本机酒馆设置中。</small>
            </div>
          </div>
        </div>`;

        const container = $('#extensions_settings2').length ? $('#extensions_settings2') : $('#extensions_settings');
        container.append(html);

        $('#ccm_update_btn').on('click', () => {
            if (updState === 'available') { doUpdate(); return; }
            if (updState === 'updated') { location.reload(); return; }
            checkUpdate(false);
        });
        $('#ccm_open_btn').on('click', () => openManager());

        setupWandMenu();
        setupSlashCommand();
        setupRecentTracking();
        setTimeout(() => checkUpdate(true), 3000);

        console.log('[角色卡管理] v' + VERSION + ' 已加载');
    });
})();
