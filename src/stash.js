let g_stashed; // index of stashed sets
let g_windows; // current windows and tabs
let g_focused; // current window with tabs
let g_show_badge = true; // show count of stashes on toolbar icon

function $$(selector) {
    return document.querySelector(selector);
}

function plural(count, object, suffix = "s") {
    return count + " " + object + (count === 1 ? "" : suffix);
}

function stash_exists(name) {
    name = name.trim().toLowerCase();
    return g_stashed.some((s) => {
        return s.name === name;
    });
}

function update_badge() {
    if (g_show_badge) {
        browser.browserAction.setBadgeText({
            text: `${g_stashed.length || ""}`,
        });
    } else {
        browser.browserAction.setBadgeText({ text: "" });
    }
}

function show_create_form() {
    const name_el = $$("#name");
    const create_el = $$("#create-preview");

    // switch popup from list to create form
    const is_all = document.body.dataset.action === "all";

    // show title and preview
    let windows;
    if (is_all) {
        $$("#create-title-all").classList.remove("hidden");
        windows = g_windows;
    } else {
        $$("#create-title-current").classList.remove("hidden");
        windows = [g_focused];
    }

    // name field value setter needs to trigger keyup
    function set_name(value) {
        name_el.value = value;
        name_el.select();
        name_el.focus();

        let e = document.createEvent("HTMLEvents");
        e.initEvent("keyup", false, true);
        name_el.dispatchEvent(e);
    }

    // clicking on a tab sets the stash name to the tab's title
    function set_name_from_tab(e) {
        set_name(e.target.textContent);
    }

    // add a title or tab to the create menu
    function add_list_item(text, is_title = false) {
        let item_div = document.createElement("div");
        item_div.classList.add("panel-list-item");
        if (is_title) {
            item_div.classList.add("title", "disabled");
        } else {
            item_div.addEventListener("click", set_name_from_tab);
        }
        let text_div = document.createElement("div");
        text_div.classList.add("text");
        text_div.appendChild(document.createTextNode(text));
        item_div.appendChild(text_div);
        create_el.appendChild(item_div);
    }

    // add windows to create menu, for preview and as a quick way to set the name
    for (let w of windows) {
        add_list_item("Window (" + plural(w.tabs.length, "tab") + ")", true);
        for (let t of w.tabs) {
            add_list_item(t.title);
        }
    }

    // show form and focus name
    $$("#popup").classList.add("hidden");
    $$("#create").classList.remove("hidden");

    // and set the default name
    let name = "Untitled";
    if (g_focused) {
        for (let t of g_focused.tabs) {
            if (t.active) {
                name = t.title;
                break;
            }
        }
    }
    set_name(name);
}

async function stash(windows) {
    let title = $$("#name").value.trim();
    let name = title.toLowerCase();

    // check for existing name
    if (stash_exists(name)) {
        console.error("stash: '" + name + "' already exists");
        return;
    }

    // disable ui to show activity
    $$("#save-btn").classList.add("disabled");
    $$("#save-btn").disabled = true;

    const stash_id = "i" + Date.now();

    // update index
    let tab_count = 0;
    for (let w of windows) {
        tab_count += w.tabs.length;
    }
    g_stashed.push({
        id: stash_id,
        name: name,
        title: title,
        summary:
            plural(windows.length, "window") + ", " + plural(tab_count, "tab"),
    });
    update_badge();
    await browser.storage.sync.set({
        index: g_stashed,
    });

    // extract window ids (no need to store these)
    let window_ids = [];
    for (let w of windows) {
        window_ids.push(w.id);
        delete w.id;
    }

    // store `windows`
    await browser.storage.sync.set({
        [stash_id]: windows,
    });

    // close windows
    window_ids.forEach((id) => {
        browser.windows.remove(id);
    });
}

async function restore(stash_id) {
    // grab stashed tabs
    let res = await browser.storage.sync.get(stash_id);
    if (!res[stash_id]) {
        await remove_stash(stash_id);
        throw "bad stash_id: " + stash_id;
    }
    let stashed = res[stash_id];

    // get current window info
    let win = await browser.windows.getCurrent({ populate: true });

    // replace current window if it has a single empty(ish) tab
    if (
        win.tabs.length === 1 &&
        (win.tabs[0].url === "about:blank" ||
            win.tabs[0].url === "about:newtab" ||
            win.tabs[0].url === "about:home")
    ) {
        let stashed_win = stashed.shift();

        // tabs --> urls
        let urls = [];
        for (let tab of stashed_win.tabs) {
            urls.push(tab.url);
        }
        delete stashed_win.tabs;

        // set window state, size
        await browser.windows.update(win.id, stashed_win);

        // replace the first tab
        let first_url = urls.shift();
        browser.tabs.update(win.tabs[0].id, {
            url: first_url,
            loadReplace: true,
        });

        // create other tabs
        for (let url of urls) {
            browser.tabs.create({ url: url });
        }
    } else {
        // otherwise create a new window
        for (let stashed_win of stashed) {
            // tabs --> url
            stashed_win.url = [];
            for (let tab of stashed_win.tabs) {
                stashed_win.url.push(tab.url);
            }
            delete stashed_win.tabs;

            // the promise returned by browser.windows.create appears to
            // never complete.
            browser.windows.create(stashed_win);
        }
    }

    await remove_stash(stash_id);
    window.close();
}

async function remove_stash(stash_id) {
    let updated = false;
    for (let i in g_stashed) {
        if (g_stashed[i].id === stash_id) {
            g_stashed.splice(i, 1);
            update_badge();
            updated = true;
            break;
        }
    }
    if (!updated) {
        return;
    }

    await browser.storage.sync.set({ index: g_stashed });
    await browser.storage.sync.remove(stash_id);
    await init_g_stashed();
}

// popup click events
async function handle_click(e) {
    // find containing panel-list-item
    let target = e.target;
    while (
        target.nodeName !== "BODY" &&
        !target.classList.contains("panel-list-item")
    ) {
        target = target.parentNode;
    }
    // must exist and be enabled
    if (target.nodeName === "BODY" || target.classList.contains("disabled")) {
        return;
    }

    // handle click
    try {
        if (target.id === "stash-current") {
            document.body.dataset.action = "current";
            show_create_form();
        } else if (target.id === "stash-all") {
            document.body.dataset.action = "all";
            show_create_form();
        } else if (target.classList.contains("stashed")) {
            await restore(target.dataset.id);
        }
    } catch (e) {
        console.error("stash:", e);
        window.close();
    }
}
document.addEventListener("click", handle_click);

function init_form() {
    $$("#name").addEventListener("keypress", (e) => {
        if (e.keyCode === 13) {
            $$("#save-btn").click();
        }
    });
    $$("#name").addEventListener("keyup", () => {
        let name = $$("#name").value.trim();

        if (stash_exists(name)) {
            $$("#create-exists").classList.remove("hidden");
            $$("#save-btn").classList.add("disabled");
            $$("#save-btn").disabled = true;
            return;
        }
        $$("#create-exists").classList.add("hidden");

        if (name === "") {
            $$("#save-btn").classList.add("disabled");
            $$("#save-btn").disabled = true;
            return;
        }
        $$("#save-btn").classList.remove("disabled");
        $$("#save-btn").disabled = false;
    });
    $$("#save-btn").addEventListener("click", () => {
        if ($$("#save-btn").disabled) {
            return;
        }
        if (document.body.dataset.action === "current") {
            stash([g_focused]);
        } else {
            stash(g_windows);
        }
    });
}

async function init_g_windows() {
    // capture list of current windows
    let windows = await browser.windows.getAll({ populate: true });

    // load all windows into g_windows, point g_focused at focused window
    g_windows = [];
    g_focused = undefined;
    for (let w of windows) {
        let cur_win = {
            id: w.id,
            state: w.state,
            tabs: [],
        };

        // some states cannot be combined with dimensions
        if (
            w.state !== "minimized" &&
            w.state !== "maximized" &&
            w.state !== "fullscreen"
        ) {
            cur_win.top = w.top;
            cur_win.left = w.left;
            cur_win.width = w.width;
            cur_win.height = w.height;
        }

        for (let t of w.tabs) {
            // always skip about: pages
            if (t.url.startsWith("about:")) {
                continue;
            }
            cur_win.tabs.push({
                url: t.url,
                title: t.title,
                active: t.active,
                pinned: t.pinned,
            });
            if (w.focused) {
                g_focused = cur_win;
            }
        }
        // ignore windows that just contain about: tabs
        if (cur_win.tabs.length) {
            g_windows.push(cur_win);
        }
    }

    // enable stash menu items
    if (g_focused) {
        $$("#stash-current").classList.remove("disabled");
    } else {
        $$("#stash-current").title = "No stashable tabs";
    }
    if (g_windows.length > 1) {
        $$("#stash-all").classList.remove("disabled");
    } else if (g_windows.length === 1) {
        $$("#stash-all").title = "Only one window";
    } else {
        $$("#stash-all").title = "No stashable tabs";
    }
}

async function init_g_stashed() {
    const popup_el = $$("#popup");

    function add_list_item(id, text, title) {
        let item_div = document.createElement("div");
        item_div.classList.add("panel-list-item", "stashed");
        item_div.dataset.id = id;
        let text_div = document.createElement("div");
        text_div.classList.add("text");
        text_div.title = title;
        text_div.appendChild(document.createTextNode(text));
        item_div.appendChild(text_div);
        popup_el.appendChild(item_div);
    }

    g_stashed = [];
    let stashed_item = $$("#popup .stashed");
    while (stashed_item) {
        stashed_item.parentNode.removeChild(stashed_item);
        stashed_item = $$("#popup .stashed");
    }

    let res = await browser.storage.sync.get(["index", "hide_badge"]);
    try {
        g_show_badge = !res.hide_badge;

        if (!res.index) {
            return;
        }

        g_stashed = res.index.filter((s) => s);
        if (!g_stashed.length) {
            return;
        }

        $$("#stash-empty").classList.add("hidden");
        for (let s of g_stashed) {
            add_list_item(s.id, s.title, s.summary);
        }
    } finally {
        update_badge();
    }
}

async function startup() {
    try {
        init_form();
        await init_g_windows();
        await init_g_stashed();
    } catch (e) {
        console.error("stash:", e);
    }
}

startup();
