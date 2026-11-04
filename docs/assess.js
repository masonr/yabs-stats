'use strict';

// ---------------------------------------------------------------------------
// YABS Result Assessor — page glue (DOM only)
// ---------------------------------------------------------------------------

const EXAMPLE = `# ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## #
#              Yet-Another-Bench-Script              #
#                     v2026-10-31                    #
# https://github.com/masonr/yet-another-bench-script #
# ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## #

Thu Feb 13 07:01:48 AM EST 2025

Basic System Information:
---------------------------------
Uptime     : 0 days, 0 hours, 21 minutes
Processor  : AMD Ryzen 9 7950X3D 16-Core Processor
CPU cores  : 2 @ 4191.912 MHz
AES-NI     : ✔ Enabled
VM-x/AMD-V : ✔ Enabled
RAM        : 3.8 GiB
Swap       : 128.0 MiB
Disk       : 98.2 GiB
Distro     : Debian GNU/Linux 12 (bookworm)
Kernel     : 6.1.0-9-amd64
VM Type    : KVM
IPv4/IPv6  : ✔ Online / ❌ Offline

IPv4 Network Information:
---------------------------------
ISP        : Example Networks GmbH
ASN        : AS64496 Example Networks
Host       : Example Cloud
Location   : Frankfurt am Main, Hesse (HE)
Country    : Germany

fio Disk Speed Tests (Mixed R/W 50/50) (Partition /dev/vda1):
---------------------------------
Block Size | 4k            (IOPS) | 64k           (IOPS)
  ------   | ---            ----  | ----           ----
Read       | 45.43 MB/s   (11.3k) | 461.52 MB/s   (7.2k)
Write      | 45.52 MB/s   (11.3k) | 463.95 MB/s   (7.2k)
Total      | 90.95 MB/s   (22.7k) | 925.48 MB/s  (14.4k)
           |                      |
Block Size | 512k          (IOPS) | 1m            (IOPS)
  ------   | ---            ----  | ----           ----
Read       | 840.34 MB/s   (1.6k) | 853.47 MB/s    (833)
Write      | 884.99 MB/s   (1.7k) | 910.31 MB/s    (888)
Total      | 1.72 GB/s     (3.3k) | 1.76 GB/s     (1.7k)

iperf3 Network Speed Tests (IPv4):
---------------------------------
Provider        | Location (Link)           | Send Speed      | Recv Speed      | Ping
-----           | -----                     | ----            | ----            | ----
Clouvider       | London, UK (10G)          | 1.95 Gbits/sec  | 1.43 Gbits/sec  | 10.7 ms
Eranium         | Amsterdam, NL (100G)      | 2.04 Gbits/sec  | 1.81 Gbits/sec  | 3.52 ms
Uztelecom       | Tashkent, UZ (10G)        | 646 Mbits/sec   | 984 Mbits/sec   | 91.9 ms
Leaseweb        | Singapore, SG (10G)       | 316 Mbits/sec   | 1.05 Gbits/sec  | 177 ms
Clouvider       | Los Angeles, CA, US (10G) | 399 Mbits/sec   | 495 Mbits/sec   | 142 ms
Leaseweb        | NYC, NY, US (10G)         | 620 Mbits/sec   | 1.35 Gbits/sec  | 77.9 ms
Edgoo           | Sao Paulo, BR (1G)        | busy            | 304 Mbits/sec   | 213 ms

Geekbench 6 Benchmark Test:
---------------------------------
Test            | Value
                |
Single Core     | 1702
Multi Core      | 3039
Full Test       | https://browser.geekbench.com/v6/cpu/12345678

YABS completed in 9 min 12 sec`;

const WIKI_BASE = 'https://github.com/masonr/yet-another-bench-script/wiki/Interpreting-Results';
const VERDICT_LABEL = {
    healthy: 'Healthy',
    mixed: 'Mixed',
    concerning: 'Concerning',
    incomplete: 'Incomplete',
};

const $ = id => document.getElementById(id);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getCtx() {
    return {
        soldStorage: $('sold-storage').value,
        soldPortMbps: $('sold-port').value ? parseInt($('sold-port').value, 10) : null,
    };
}

function wikiHref(wiki) {
    return /^https?:/.test(wiki) ? wiki : WIKI_BASE + wiki;
}

function wikiTitle(wiki) {
    let page = 'Interpreting Results', anchor = '';
    if (/^https?:/.test(wiki)) {
        const m = wiki.match(/\/wiki\/([^#]+)(?:#(.*))?$/);
        if (!m) return 'Wiki';
        page = m[1].replace(/-/g, ' ');
        anchor = m[2] || '';
    } else {
        anchor = wiki.replace(/^#/, '');
    }
    return 'Wiki: ' + page + (anchor ? ' § ' + anchor.replace(/-/g, ' ') : '');
}

function appendTextWithLinks(el, text) {
    const parts = String(text).split(/(https?:\/\/[^\s)]+)/g);
    for (const p of parts) {
        if (/^https?:/.test(p)) {
            const a = document.createElement('a');
            a.href = p;
            a.textContent = p;
            a.target = '_blank';
            a.rel = 'noopener';
            el.appendChild(a);
        } else if (p) {
            el.appendChild(document.createTextNode(p));
        }
    }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderVerdict(result, noData) {
    const v = $('verdict');
    v.className = `verdict verdict--${result.overall}`;
    v.innerHTML = '';

    const label = document.createElement('span');
    label.className = 'verdict-label';
    label.textContent = VERDICT_LABEL[result.overall] || result.overall;
    v.appendChild(label);

    const summary = document.createElement('span');
    summary.className = 'verdict-summary';
    const counts = (result.derived && result.derived.severityCounts) || {};
    if (result.overall === 'incomplete') {
        summary.textContent = noData
            ? 'Could not find YABS data in the paste.'
            : 'No disk, network or CPU results found — only system information.';
    } else {
        const bits = [];
        if (counts.bad) bits.push(`${counts.bad} problem${counts.bad > 1 ? 's' : ''}`);
        if (counts.warn) bits.push(`${counts.warn} warning${counts.warn > 1 ? 's' : ''}`);
        summary.textContent = bits.length
            ? ' — ' + bits.join(', ') + ' found. Verdicts are "consistent with" signatures, not proof — re-run at another hour.'
            : ' — no warnings. Verdicts are "consistent with" signatures, not proof — re-run at another hour.';
    }
    v.appendChild(summary);
}

function renderArea(areaId, area) {
    const card = $(areaId);
    card.querySelector('.area-headline').textContent = area.headline || 'No data.';
    const ul = card.querySelector('.findings');
    ul.innerHTML = '';
    for (const x of area.findings) {
        const li = document.createElement('li');

        const dot = document.createElement('span');
        dot.className = `sev-dot sev-${x.severity}`;
        li.appendChild(dot);

        const title = document.createElement('strong');
        title.className = 'finding-title';
        title.textContent = x.title;
        li.appendChild(title);
        li.appendChild(document.createTextNode(' '));

        const a = document.createElement('a');
        a.className = 'wiki-link';
        a.href = wikiHref(x.wiki);
        a.target = '_blank';
        a.rel = 'noopener';
        a.title = wikiTitle(x.wiki);
        a.textContent = 'wiki →';
        li.appendChild(a);

        if (x.detail) {
            const detail = document.createElement('div');
            detail.className = 'finding-detail';
            appendTextWithLinks(detail, x.detail);
            li.appendChild(detail);
        }
        ul.appendChild(li);
    }
}

function renderParsed(model, derived) {
    const body = $('parsed-body');
    body.innerHTML = '';
    const table = document.createElement('table');
    table.className = 'parsed-table';

    const addRow = (k, v) => {
        if (v == null || v === '') return;
        const tr = document.createElement('tr');
        const th = document.createElement('th');
        th.textContent = k;
        const td = document.createElement('td');
        td.textContent = String(v);
        tr.appendChild(th);
        tr.appendChild(td);
        table.appendChild(tr);
    };

    const s = model.sys;
    addRow('Format', model.format + (model.version ? ` (${model.version})` : ''));
    addRow('Run at', [model.runDate || model.date,
        model.runHour != null ? `${String(model.runHour).padStart(2, '0')}:00 local` : null]
        .filter(Boolean).join(' '));
    addRow('Arch', s.arch);
    addRow('CPU', [s.cpuModel, s.cores != null ? `${s.cores} cores` : null,
        s.mhz != null ? `${s.mhz} MHz` : null].filter(Boolean).join(', '));
    addRow('RAM / Swap / Disk', [s.ramGiB, s.swapGiB, s.diskGiB]
        .map(v => v == null ? '?' : (Math.round(v * 100) / 100) + ' GiB').join(' / '));
    addRow('VM Type', s.vmType);
    addRow('Uptime', s.uptimeSec != null ? `${Math.round(s.uptimeSec / 60)} min` : null);

    for (const bs of ['4k', '64k', '512k', '1m']) {
        const r = model.disk.rows[bs];
        if (!r) continue;
        addRow(`fio ${bs} total`,
            `${r.totalMBps != null ? Math.round(r.totalMBps * 100) / 100 + ' MB/s' : '?'} · ` +
            `${r.totalIops != null ? Math.round(r.totalIops).toLocaleString('en-US') + ' IOPS' : '?'}`);
    }
    if (model.disk.dd) {
        addRow('dd avg', `write ${model.disk.dd.writeMBps} MB/s · read ${model.disk.dd.readMBps} MB/s`);
    }
    addRow('Disk medium', derived.diskMediumLabel);
    addRow('iperf rows',
        `${model.iperf.IPv4.length} IPv4 · ${model.iperf.IPv6.length} IPv6`);
    addRow('iperf peak', derived.peakMbps != null
        ? `${Math.round(derived.peakMbps)} Mbit/s (port ≈ ${derived.portMbps})` : null);
    for (const g of model.geekbench) {
        addRow(`Geekbench ${g.version}`, `${g.single} / ${g.multi}`);
    }
    addRow('Runtime', model.runtimeSec != null ? `${model.runtimeSec} sec` : null);
    for (const w of model.warnings) addRow('Warning', w);
    body.appendChild(table);
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function runAssess() {
    const input = $('yabs-input').value;
    let model = null;
    try {
        if (input.trim()) model = YabsParse.parse(input);
    } catch (e) {
        model = null;
    }

    $('results').hidden = false;
    if (!model || !YabsParse.hasData(model)) {
        renderVerdict({ overall: 'incomplete', derived: {} }, true);
        for (const id of ['area-disk', 'area-network', 'area-cpu', 'area-context']) {
            $(id).querySelector('.area-headline').textContent = '';
            $(id).querySelector('.findings').innerHTML = '';
        }
        $('parsed-body').innerHTML = '';
        return;
    }

    const result = YabsRules.assess(model, getCtx());
    renderVerdict(result, false);
    renderArea('area-disk', result.areas.disk);
    renderArea('area-network', result.areas.network);
    renderArea('area-cpu', result.areas.cpu);
    renderArea('area-context', result.areas.context);
    renderParsed(model, result.derived);
}

$('btn-assess').addEventListener('click', runAssess);
$('btn-example').addEventListener('click', () => {
    $('yabs-input').value = EXAMPLE;
    runAssess();
});
$('btn-clear').addEventListener('click', () => {
    $('yabs-input').value = '';
    $('results').hidden = true;
});
$('sold-storage').addEventListener('change', () => {
    if ($('yabs-input').value.trim() && !$('results').hidden) runAssess();
});
$('sold-port').addEventListener('change', () => {
    if ($('yabs-input').value.trim() && !$('results').hidden) runAssess();
});
