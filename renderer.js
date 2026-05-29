let db = [];
let boardSections = {};
const expandedBoards = new Set();
const collapsedSectionsByBoard = {};
let autoScrollInterval = null;
let contextMenuPinIndex = null;

// Undo stack for deleted pins
const undoStack = [];
const MAX_UNDO = 50;   // keep up to 50 deletions

/* ---------------- STORAGE ---------------- */

const STORAGE_KEY = 'pinterest-archive-state';

function saveState() {
    const state = {
        db: db.map(pin => ({
            ...pin,
            date: pin.date ? pin.date.toISOString() : null
        })),
        boardSections
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function loadState() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    try {
        const state = JSON.parse(raw);
        db = state.db.map(pin => ({
            ...pin,
            date: pin.date ? new Date(pin.date) : null
        }));
        boardSections = state.boardSections || {};
        return true;
    } catch (e) {
        console.error('Failed to load saved state:', e);
        return false;
    }
}

/* ---------------- HELPERS ---------------- */

function cleanText(t) {
    return (t || '')
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/<[^>]+>/g, '')
        .trim();
}

function extractTweetUrl(text) {
    const m = text?.match(/https?:\/\/(x\.com|twitter\.com)\/[^\s"'<>]+/);
    return m ? m[0] : '';
}

function extractTweetId(url) {
    const m = url?.match(/status\/(\d+)/);
    return m ? m[1] : null;
}

function getPinId(block) {
    const m = block.match(/^(\d+)/);
    return m ? m[1] : null;
}

function snowflakeToDate(id) {
    try {
        const epoch = 1288834974657n;
        return new Date(Number((BigInt(id) >> 22n) + epoch));
    } catch {
        return null;
    }
}

function extractImageHash(block) {
    const storyMediaMatch = block.match(/"Story Pin Media"\s*:\s*\[([^\]]+)\]/);
    if (storyMediaMatch) {
        const inner = storyMediaMatch[1];
        const imageMatch = inner.match(/"image"\s*:\s*"([^"]+)"/);
        if (imageMatch) return imageMatch[1];
    }
    const m = block.match(/Image:\s*(\S+)/);
    if (m) {
        const val = m[1].trim();
        if (/^[a-f0-9]+$/i.test(val)) return val;
    }
    return null;
}

function imageHashToThumbnail(hash) {
    if (!hash || hash.length < 6) return null;
    const a = hash.substring(0, 2);
    const b = hash.substring(2, 4);
    const c = hash.substring(4, 6);
    return `https://i.pinimg.com/originals/${a}/${b}/${c}/${hash}.jpg`;
}

/* ---------------- IMPORT ---------------- */

async function importFiles(files) {
    // Clear undo stack on fresh import
    undoStack.length = 0;

    let addedCount = 0;

    for (const file of files) {
        const text = await file.text();
        const blocks = text.split('https://www.pinterest.com/pin/');

        for (let i = 1; i < blocks.length; i++) {
            const b = blocks[i];

            const title = cleanText((b.match(/Title:\s*(.+)/) || [])[1]);
            const board = cleanText((b.match(/Board Name:\s*(.+)/) || [])[1]);
            const canonical = (b.match(/Canonical Link:\s*(.+)/) || [])[1];

            const tweetUrl = extractTweetUrl(canonical);
            if (!tweetUrl) continue;

            const pinId = getPinId(b);
            const pinUrl = pinId ? `https://www.pinterest.com/pin/${pinId}/` : null;
            if (!pinUrl) continue;

            const alreadyExists = db.some(pin => pin.pinUrl === pinUrl);
            if (alreadyExists) continue;

            const tweetId = extractTweetId(tweetUrl);
            const imageHash = extractImageHash(b);

            db.push({
                title: title || "Untitled",
                board: board || "Unknown",
                tweetUrl,
                pinUrl,
                date: tweetId ? snowflakeToDate(tweetId) : null,
                section: 'Uncategorized',
                imageHash: imageHash || null
            });
            addedCount++;
        }
    }

    if (addedCount > 0) {
        const boardsWithNewPins = new Set(
            db.filter(p => (p.section || 'Uncategorized') === 'Uncategorized' && p.board)
               .map(p => p.board)
        );
        boardsWithNewPins.forEach(board => {
            if (!boardSections[board]) {
                boardSections[board] = [];
            }
        });

        saveState();
        render();

        alert(`Added ${addedCount} new pin(s).`);
    } else {
        alert('No new pins found (all already imported).');
    }
}

/* ---------------- DATA MODIFIERS ---------------- */

function addSection(board, name) {
    if (!boardSections[board]) boardSections[board] = [];
    if (boardSections[board].includes(name)) return;
    boardSections[board].push(name);
    saveState();
    render();
}

function renameSection(board, oldName, newName) {
    if (!boardSections[board]) return;
    const idx = boardSections[board].indexOf(oldName);
    if (idx === -1) return;
    if (boardSections[board].includes(newName)) return;
    boardSections[board][idx] = newName;
    db.forEach(p => {
        if (p.board === board && (p.section || 'Uncategorized') === oldName) {
            p.section = newName;
        }
    });

    if (collapsedSectionsByBoard[board]) {
        if (collapsedSectionsByBoard[board].has(oldName)) {
            collapsedSectionsByBoard[board].delete(oldName);
            collapsedSectionsByBoard[board].add(newName);
        }
    }

    saveState();
    render();
}

function movePin(pinIndex, board, newSection) {
    const pin = db[pinIndex];
    if (!pin || pin.board !== board) return;
    pin.section = newSection;
    saveState();
    render();
}

function deletePin(pinIndex) {
    if (pinIndex >= 0 && pinIndex < db.length) {
        const removed = db.splice(pinIndex, 1)[0];
        // Push onto undo stack (keep a copy)
        undoStack.push({ ...removed });
        if (undoStack.length > MAX_UNDO) {
            undoStack.shift();
        }
        saveState();
        render();
    }
}

function undoDelete() {
    if (undoStack.length === 0) return;
    const restored = undoStack.pop();
    db.push(restored);
    saveState();
    render();
}

function reorderSections(board, oldIndex, newIndex) {
    const sections = boardSections[board];
    if (!sections || oldIndex < 0 || oldIndex >= sections.length) return;
    const [removed] = sections.splice(oldIndex, 1);
    sections.splice(newIndex, 0, removed);
    saveState();
    render();
}

/* ---------------- RENDER ---------------- */

function render() {
    hideContextMenu();

    const sorted = [...db].sort((a, b) => {
        const da = a.date ? new Date(a.date).getTime() : 0;
        const dbb = b.date ? new Date(b.date).getTime() : 0;
        return dbb - da;
    });

    const boards = {};
    sorted.forEach(p => {
        if (!boards[p.board]) boards[p.board] = [];
        boards[p.board].push(p);
    });

    let html = '';

    for (const board in boards) {
        const boardId = board.replace(/\s+/g, '_');
        const pins = boards[board];
        const totalPins = pins.length;

        let customSections = boardSections[board] || [];
        const uncategorizedPins = pins.filter(p => (p.section || 'Uncategorized') === 'Uncategorized');
        const hasUncategorized = uncategorizedPins.length > 0;

        if (!boardSections[board]) {
            boardSections[board] = [];
        }

        if (!collapsedSectionsByBoard[board]) {
            collapsedSectionsByBoard[board] = new Set();
        }

        html += `
        <div class="board">
            <div class="board-header" data-board="${board.replace(/"/g, '&quot;')}">
                <div>${board}</div>
                <div>${totalPins} pins</div>
            </div>

            <div class="board-content" id="${boardId}">
                <div class="sections-container" data-board="${board.replace(/"/g, '&quot;')}">
                    <button class="add-section-btn" data-board="${board.replace(/"/g, '&quot;')}">+ Add Section</button>`;

        customSections.forEach((sec, secIndex) => {
            if (sec === 'Uncategorized') return;
            const secPins = pins.filter(p => (p.section || 'Uncategorized') === sec);
            secPins.sort((a, b) => (b.date?.getTime() || 0) - (a.date?.getTime() || 0));

            const isCollapsed = collapsedSectionsByBoard[board].has(sec);
            const arrow = isCollapsed ? '▶' : '▼';
            const collapsedClass = isCollapsed ? ' collapsed' : '';

            html += `
                <div class="section${collapsedClass}" data-board="${board.replace(/"/g, '&quot;')}" data-section="${sec.replace(/"/g, '&quot;')}">
                    <div class="section-header" draggable="true" data-board="${board.replace(/"/g, '&quot;')}" data-section-index="${secIndex}">
                        <span class="section-toggle">${arrow}</span>
                        <span class="section-name" contenteditable="false">${sec}</span>
                        <span class="section-count">${secPins.length}</span>
                        <button class="rename-section-btn" data-board="${board.replace(/"/g, '&quot;')}" data-section="${sec.replace(/"/g, '&quot;')}">✎</button>
                    </div>
                    <div class="grid section-grid">`;

            secPins.forEach(p => {
                const pinIndex = db.indexOf(p);
                const imgSrc = p.imageHash ? imageHashToThumbnail(p.imageHash) : '';
                html += `
                    <div class="card" draggable="true" data-pin-index="${pinIndex}">
                        ${imgSrc ? `<div class="card-image"><img src="${imgSrc}" loading="lazy" onerror="this.style.display='none'"></div>` : ''}
                        <div class="title">${p.title}</div>
                        <div class="date">${p.date ? new Date(p.date).toLocaleString() : 'Unknown date'}</div>
                        ${p.pinUrl ? `<a href="${p.pinUrl}" target="_blank">Open Pin</a>` : ""}
                        ${p.tweetUrl ? `<a href="${p.tweetUrl}" target="_blank">Open Tweet</a>` : ""}
                    </div>`;
            });

            html += `</div></div>`;
        });

        html += `</div>`; // close sections-container

        if (hasUncategorized) {
            html += `
                <div class="uncategorized-area" data-board="${board.replace(/"/g, '&quot;')}" data-section="Uncategorized">
                    <div class="uncategorized-label">Uncategorized</div>
                    <div class="grid uncategorized-grid">`;

            uncategorizedPins.forEach(p => {
                const pinIndex = db.indexOf(p);
                const imgSrc = p.imageHash ? imageHashToThumbnail(p.imageHash) : '';
                html += `
                    <div class="card" draggable="true" data-pin-index="${pinIndex}">
                        ${imgSrc ? `<div class="card-image"><img src="${imgSrc}" loading="lazy" onerror="this.style.display='none'"></div>` : ''}
                        <div class="title">${p.title}</div>
                        <div class="date">${p.date ? new Date(p.date).toLocaleString() : 'Unknown date'}</div>
                        ${p.pinUrl ? `<a href="${p.pinUrl}" target="_blank">Open Pin</a>` : ""}
                        ${p.tweetUrl ? `<a href="${p.tweetUrl}" target="_blank">Open Tweet</a>` : ""}
                    </div>`;
            });

            html += `</div></div>`;
        }

        html += `</div></div>`; // close board-content, board
    }

    document.getElementById("app").innerHTML = html;

    // Restore expanded boards
    expandedBoards.forEach(board => {
        const boardId = board.replace(/\s+/g, '_');
        const content = document.getElementById(boardId);
        if (content) content.style.display = 'block';
    });

    attachListeners();
}

/* ---------------- EVENT LISTENERS ---------------- */

function attachListeners() {
    // Board toggle
    document.querySelectorAll('.board-header').forEach(header => {
        header.addEventListener('click', (e) => {
            const board = e.currentTarget.dataset.board;
            const boardId = board.replace(/\s+/g, '_');
            const content = document.getElementById(boardId);
            if (!content) return;
            if (content.style.display === 'block') {
                content.style.display = 'none';
                expandedBoards.delete(board);
            } else {
                content.style.display = 'block';
                expandedBoards.add(board);
            }
        });
    });

    // Add section inline input
    document.querySelectorAll('.add-section-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const board = e.target.dataset.board;
            const input = document.createElement('input');
            input.type = 'text';
            input.placeholder = 'Section name';
            input.className = 'inline-section-input';
            input.style.cssText = 'margin-left:8px; padding:4px 8px; background:#1a1b1e; color:white; border:1px solid #4aa3ff; border-radius:4px;';

            e.target.replaceWith(input);
            input.focus();

            const commit = () => {
                const name = input.value.trim();
                if (name) {
                    addSection(board, name);
                } else {
                    render();
                }
            };

            input.addEventListener('blur', commit);
            input.addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter') {
                    input.removeEventListener('blur', commit);
                    commit();
                } else if (ev.key === 'Escape') {
                    input.value = '';
                    input.removeEventListener('blur', commit);
                    commit();
                }
            });
        });
    });

    // Rename section (contenteditable)
    document.querySelectorAll('.rename-section-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const board = e.target.dataset.board;
            const oldName = e.target.dataset.section;
            const sectionEl = e.target.closest('.section');
            const nameSpan = sectionEl.querySelector('.section-name');

            nameSpan.contentEditable = 'true';
            nameSpan.classList.add('editing');
            const range = document.createRange();
            range.selectNodeContents(nameSpan);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            nameSpan.focus();

            const finish = (cancel) => {
                const newName = nameSpan.textContent.trim();
                nameSpan.contentEditable = 'false';
                nameSpan.classList.remove('editing');
                nameSpan.removeEventListener('blur', blurHandler);
                nameSpan.removeEventListener('keydown', keyHandler);
                if (cancel || newName === oldName || !newName) {
                    nameSpan.textContent = oldName;
                } else {
                    renameSection(board, oldName, newName);
                }
            };

            const blurHandler = () => finish(false);
            const keyHandler = (ev) => {
                if (ev.key === 'Enter') {
                    ev.preventDefault();
                    finish(false);
                } else if (ev.key === 'Escape') {
                    ev.preventDefault();
                    finish(true);
                }
            };

            nameSpan.addEventListener('blur', blurHandler);
            nameSpan.addEventListener('keydown', keyHandler);
        });
    });

    // Section collapse toggle
    document.querySelectorAll('.section-toggle').forEach(toggle => {
        toggle.addEventListener('click', (e) => {
            e.stopPropagation();
            const sectionEl = e.currentTarget.closest('.section');
            const board = sectionEl.dataset.board;
            const sectionName = sectionEl.dataset.section;
            if (!collapsedSectionsByBoard[board]) {
                collapsedSectionsByBoard[board] = new Set();
            }
            const isCollapsed = collapsedSectionsByBoard[board].has(sectionName);
            if (isCollapsed) {
                collapsedSectionsByBoard[board].delete(sectionName);
                sectionEl.classList.remove('collapsed');
                e.currentTarget.textContent = '▼';
            } else {
                collapsedSectionsByBoard[board].add(sectionName);
                sectionEl.classList.add('collapsed');
                e.currentTarget.textContent = '▶';
            }
        });
    });

    // Drag & drop – pins (cards)
    document.querySelectorAll('.card').forEach(card => {
        card.addEventListener('dragstart', handlePinDragStart);
        card.addEventListener('contextmenu', handlePinContextMenu);
    });

    document.querySelectorAll('.section').forEach(section => {
        section.addEventListener('dragover', handlePinDragOver);
        section.addEventListener('dragleave', handlePinDragLeave);
        section.addEventListener('drop', handlePinDrop);
    });

    document.querySelectorAll('.uncategorized-area').forEach(area => {
        area.addEventListener('dragover', handlePinDragOver);
        area.addEventListener('dragleave', handlePinDragLeave);
        area.addEventListener('drop', handlePinDrop);
    });

    // Drag & drop – sections (reorder)
    document.querySelectorAll('.section-header').forEach(header => {
        header.addEventListener('dragstart', handleSectionDragStart);
    });

    document.querySelectorAll('.sections-container').forEach(container => {
        container.addEventListener('dragover', handleSectionDragOver);
        container.addEventListener('drop', handleSectionDrop);
    });

    // Open Twitter/X links in system browser
    document.querySelectorAll('a[href*="x.com"], a[href*="twitter.com"]').forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            if (window.api && window.api.openExternal) {
                window.api.openExternal(link.href);
            }
        });
    });

    // Auto‑scroll during drag
    document.removeEventListener('dragover', autoScrollHandler);
    document.removeEventListener('dragend', stopAutoScroll);
    document.addEventListener('dragover', autoScrollHandler);
    document.addEventListener('dragend', stopAutoScroll);
}

/* ---------------- PIN DRAG & DROP ---------------- */

let dragPinIndex = null;

function handlePinDragStart(e) {
    const card = e.target.closest('.card');
    if (!card) return;
    dragPinIndex = parseInt(card.dataset.pinIndex);
    e.dataTransfer.setData('text/plain', dragPinIndex);
    e.dataTransfer.effectAllowed = 'move';
}

function handlePinDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    e.currentTarget.classList.add('drag-over');
}

function handlePinDragLeave(e) {
    const dropZone = e.currentTarget;
    if (!dropZone.contains(e.relatedTarget)) {
        dropZone.classList.remove('drag-over');
    }
}

function handlePinDrop(e) {
    e.preventDefault();
    const dropZone = e.currentTarget;
    dropZone.classList.remove('drag-over');

    const targetBoard = dropZone.dataset.board;
    const targetSection = dropZone.dataset.section;
    const pinIndex = parseInt(e.dataTransfer.getData('text/plain'));
    const pin = db[pinIndex];
    if (!pin || pin.board !== targetBoard) return;
    if ((pin.section || 'Uncategorized') === targetSection) return;

    movePin(pinIndex, targetBoard, targetSection);
}

/* ---------------- SECTION DRAG & DROP (REORDER) ---------------- */

let sectionDragData = null;

function handleSectionDragStart(e) {
    const header = e.currentTarget;
    const board = header.dataset.board;
    const index = parseInt(header.dataset.sectionIndex);
    sectionDragData = { board, index };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', '');
}

function handleSectionDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
}

function handleSectionDrop(e) {
    e.preventDefault();
    const container = e.currentTarget;
    const board = container.dataset.board;

    if (!sectionDragData || sectionDragData.board !== board) {
        sectionDragData = null;
        return;
    }

    const oldIndex = sectionDragData.index;
    const sections = boardSections[board];
    if (!sections) { sectionDragData = null; return; }

    const mouseY = e.clientY;
    const sectionHeaders = [...container.querySelectorAll('.section-header')];
    let newIndex = sections.length;

    for (let i = 0; i < sectionHeaders.length; i++) {
        const rect = sectionHeaders[i].getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        if (mouseY < midY) {
            newIndex = i;
            break;
        }
    }

    if (oldIndex < newIndex) newIndex--;
    if (oldIndex === newIndex || newIndex < 0 || newIndex >= sections.length) {
        sectionDragData = null;
        return;
    }

    reorderSections(board, oldIndex, newIndex);
    sectionDragData = null;
}

/* ---------------- CONTEXT MENU ---------------- */

function createContextMenuElement() {
    let menu = document.getElementById('contextMenu');
    if (!menu) {
        menu = document.createElement('div');
        menu.id = 'contextMenu';
        menu.className = 'context-menu';
        menu.innerHTML = '<div class="context-menu-item" id="deletePinItem">Delete Pin</div>';
        document.body.appendChild(menu);

        document.addEventListener('click', (e) => {
            if (!menu.contains(e.target)) {
                hideContextMenu();
            }
        });

        menu.querySelector('#deletePinItem').addEventListener('click', () => {
            if (contextMenuPinIndex !== null) {
                deletePin(contextMenuPinIndex);
            }
            hideContextMenu();
        });

        menu.addEventListener('contextmenu', (e) => e.preventDefault());
    }
    return menu;
}

function showContextMenu(x, y, pinIndex) {
    const menu = createContextMenuElement();
    contextMenuPinIndex = pinIndex;
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    menu.style.display = 'block';
}

function hideContextMenu() {
    const menu = document.getElementById('contextMenu');
    if (menu) {
        menu.style.display = 'none';
    }
    contextMenuPinIndex = null;
}

function handlePinContextMenu(e) {
    e.preventDefault();
    e.stopPropagation();
    const card = e.currentTarget;
    const pinIndex = parseInt(card.dataset.pinIndex);
    showContextMenu(e.clientX, e.clientY, pinIndex);
}

/* ---------------- AUTO SCROLL DURING DRAG ---------------- */

function autoScrollHandler(e) {
    const threshold = 80;
    const maxSpeed = 12;

    const mouseY = e.clientY;
    const viewHeight = window.innerHeight;

    if (mouseY < threshold) {
        const speed = -Math.min(maxSpeed, Math.round((threshold - mouseY) / 5));
        startAutoScroll(speed);
    } else if (mouseY > viewHeight - threshold) {
        const speed = Math.min(maxSpeed, Math.round((mouseY - (viewHeight - threshold)) / 5));
        startAutoScroll(speed);
    } else {
        stopAutoScroll();
    }
}

function startAutoScroll(speed) {
    if (autoScrollInterval) {
        clearInterval(autoScrollInterval);
    }
    autoScrollInterval = setInterval(() => {
        window.scrollBy(0, speed);
    }, 16);
}

function stopAutoScroll() {
    if (autoScrollInterval) {
        clearInterval(autoScrollInterval);
        autoScrollInterval = null;
    }
}

/* ---------------- UI INIT ---------------- */

window.addEventListener("DOMContentLoaded", () => {
    // Create context menu element
    createContextMenuElement();

    // Listen for undo command from menu
    if (window.api && window.api.onUndo) {
        window.api.onUndo(() => {
            undoDelete();
        });
    }

    const loaded = loadState();
    if (loaded) {
        render();
    }

    document.getElementById("importBtn").addEventListener("click", () => {
        const input = document.createElement("input");
        input.type = "file";
        input.multiple = true;
        input.onchange = async () => {
            await importFiles(input.files);
        };
        input.click();
    });
});