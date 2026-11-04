'use strict';

// ---------------------------------------------------------------------------
// YABS assessor test harness — plain assert runner (Node 17: no node:test)
// ---------------------------------------------------------------------------

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const YabsParse = require('../../docs/yabs-parse.js');
const YabsRules = require('../../docs/yabs-rules.js');

const FIX = path.join(__dirname, 'fixtures');
const read = name => fs.readFileSync(path.join(FIX, name), 'utf8');
const parse = name => YabsParse.parse(read(name));

const findings = (res, area) => res.areas[area].findings;
const has = (res, area, id, sev) =>
    findings(res, area).some(x => x.id === id && (!sev || x.severity === sev));
const find = (res, area, id) => findings(res, area).find(x => x.id === id);
const noWarnBad = (res, area) =>
    !findings(res, area).some(x => x.severity === 'warn' || x.severity === 'bad');
const close = (a, b, eps) => Math.abs(a - b) <= (eps === undefined ? 0.01 : eps);

let passed = 0;
const failures = [];
function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`ok   ${name}`);
    } catch (e) {
        failures.push({ name, err: e });
        console.log(`FAIL ${name}\n     ${e.message}`);
    }
}

// ---------------------------------------------------------------------------
// Composite report (Understanding-the-Output.md)
// ---------------------------------------------------------------------------

test('composite: parses system block', () => {
    const m = parse('composite.txt');
    assert.strictEqual(m.format, 'text');
    assert.strictEqual(m.version, 'v2026-10-31');
    assert.strictEqual(m.sys.cores, 2);
    assert.ok(close(m.sys.mhz, 4191.912, 0.001), `mhz=${m.sys.mhz}`);
    assert.ok(close(m.sys.ramGiB, 3.8, 0.05), `ram=${m.sys.ramGiB}`);
    assert.ok(close(m.sys.swapGiB, 0.125, 0.01), `swap=${m.sys.swapGiB}`);
    assert.strictEqual(m.sys.vmType, 'KVM');
    assert.strictEqual(m.sys.ipv4, true);
    assert.strictEqual(m.sys.ipv6, false);
    assert.ok(m.sys.uptimeSec > 1200 && m.sys.uptimeSec < 1300, `uptime=${m.sys.uptimeSec}`);
});

test('composite: parses fio table', () => {
    const m = parse('composite.txt');
    assert.strictEqual(m.disk.kind, 'fio');
    assert.strictEqual(m.disk.partition, '/dev/vda1');
    assert.strictEqual(m.disk.rows['4k'].totalIops, 22700);
    assert.strictEqual(m.disk.rows['1m'].totalMBps, 1760);
    assert.strictEqual(m.disk.rows['1m'].totalIops, 1700);
    assert.ok(close(m.disk.rows['64k'].totalMBps, 925.48, 0.01));
});

test('composite: parses iperf + geekbench + runtime', () => {
    const m = parse('composite.txt');
    assert.strictEqual(m.iperf.IPv4.length, 7);
    assert.strictEqual(m.iperf.IPv6.length, 0);
    const r6 = m.iperf.IPv4[6];
    assert.strictEqual(r6.sendBusy, true);
    assert.strictEqual(r6.recvMbps, 304);
    assert.strictEqual(m.iperf.IPv4[0].sendMbps, 1950);
    assert.strictEqual(m.iperf.IPv4[0].linkGbps, 10);
    assert.strictEqual(m.geekbench.length, 1);
    assert.deepStrictEqual(
        [m.geekbench[0].version, m.geekbench[0].single, m.geekbench[0].multi], [6, 1702, 3039]);
    assert.strictEqual(m.runtimeSec, 552);
});

test('composite: assessment', () => {
    const res = YabsRules.assess(parse('composite.txt'), {});
    assert.strictEqual(res.derived.diskMedium, 'nvme');
    assert.ok(has(res, 'disk', 'disk.iops-limited', 'warn'), 'missing disk.iops-limited');
    assert.ok(has(res, 'cpu', 'cpu.smt-scaling'), 'missing cpu.smt-scaling');
    assert.ok(has(res, 'context', 'ctx.fresh-vm'), 'missing ctx.fresh-vm');
    assert.ok(has(res, 'network', 'net.port-delivered', 'ok'),
        'missing net.port-delivered');
    assert.ok(!has(res, 'network', 'net.port-partial'),
        'unexpected net.port-partial (unsold port must not be judged vs inferred class)');
    assert.ok(!has(res, 'disk', 'disk.inconsistent-cells'),
        'disk.inconsistent-cells must not fire on well-formed cells');
    assert.ok(!has(res, 'context', 'ctx.quiet-hours') && !has(res, 'context', 'ctx.peak-hours'),
        '07:01 run is neither quiet nor peak hours');
    assert.strictEqual(res.overall, 'mixed');
});

test('composite: run date/hour parsed; stale-result honours ctx.now', () => {
    const m = parse('composite.txt');
    assert.strictEqual(m.runHour, 7);
    assert.strictEqual(m.runDate, '2025-02-13');
    assert.ok(has(YabsRules.assess(m, { now: '2026-10-31' }), 'context', 'ctx.stale-result'),
        'ctx.stale-result should fire for a Feb 2025 run viewed in Oct 2026');
    assert.ok(!has(YabsRules.assess(m, { now: '2025-06-01' }), 'context', 'ctx.stale-result'),
        'ctx.stale-result should not fire for a recent run');
});

// ---------------------------------------------------------------------------
// JSON example (JSON-Output-and-Integrations.md)
// ---------------------------------------------------------------------------

test('json: parses document', () => {
    const m = parse('json-example.json');
    assert.strictEqual(m.format, 'json');
    assert.strictEqual(m.version, 'v2026-10-31');
    assert.strictEqual(m.disk.rows['4k'].totalIops, 206530);
    assert.ok(close(m.disk.rows['1m'].totalMBps, 836.4, 0.5),
        `1m=${m.disk.rows['1m'].totalMBps}`);
    assert.strictEqual(m.iperf.IPv4.length + m.iperf.IPv6.length, 8);
    assert.strictEqual(m.iperf.IPv4.length, 7);
    assert.strictEqual(m.iperf.IPv6.length, 1);
    assert.strictEqual(m.iperf.IPv4[2].sendBusy, true);
    assert.strictEqual(m.iperf.IPv4[2].recvMbps, 312);
    assert.strictEqual(m.geekbench[0].version, 6);
    assert.strictEqual(m.sys.vmType, 'KVM');
    assert.strictEqual(m.sys.cores, 4);
    assert.strictEqual(m.disk.partition, '/dev/vda2');
    assert.strictEqual(m.runtimeSec, 543);
    assert.strictEqual(m.sys.ipv6, true);
    assert.strictEqual(m.sys.arch, 'x64');
    assert.strictEqual(m.runHour, 14);
    assert.strictEqual(m.runDate, '2026-10-31');
});

test('json: assess does not throw', () => {
    const res = YabsRules.assess(parse('json-example.json'), {});
    assert.ok(['healthy', 'mixed', 'concerning'].includes(res.overall));
});

// ---------------------------------------------------------------------------
// Worked example A — modern NVMe dedicated server
// ---------------------------------------------------------------------------

test('example A: nvme medium, no disk warn/bad, port delivered', () => {
    const m = parse('example-a-nvme.txt');
    const res = YabsRules.assess(m, { soldStorage: 'nvme', soldPortMbps: 1000 });
    assert.strictEqual(res.derived.diskMedium, 'nvme');
    assert.ok(noWarnBad(res, 'disk'),
        'unexpected disk warn/bad: ' + JSON.stringify(findings(res, 'disk')));
    assert.ok(has(res, 'cpu', 'cpu.no-landmarks'), 'missing cpu.no-landmarks');
    assert.ok(has(res, 'cpu', 'cpu.low-scaling', 'info'),
        'cpu.low-scaling should be info on bare metal / large N');
    assert.ok(has(res, 'network', 'net.port-delivered', 'ok'), 'missing net.port-delivered');
});

// ---------------------------------------------------------------------------
// Worked example C — cached HDD sold as SSD
// ---------------------------------------------------------------------------

test('example C: cache signature, throughput falls, multi<=single', () => {
    const res = YabsRules.assess(parse('example-c-cached-hdd.txt'), {});
    assert.ok(has(res, 'disk', 'disk.cache-signature', 'warn'), 'missing disk.cache-signature');
    assert.ok(has(res, 'disk', 'disk.throughput-falls'), 'missing disk.throughput-falls');
    assert.ok(has(res, 'cpu', 'cpu.multi-le-single', 'bad'), 'missing cpu.multi-le-single');
    assert.strictEqual(res.overall, 'concerning');
});

// ---------------------------------------------------------------------------
// Worked example E — HDD RAID storage plan
// ---------------------------------------------------------------------------

test('example E: hdd-raid override, sold checks, memory skip', () => {
    const m = parse('example-e-hdd-raid.txt');
    const unknown = YabsRules.assess(m, {});
    assert.strictEqual(unknown.derived.diskMedium, 'hdd-raid');
    assert.ok(has(unknown, 'disk', 'disk.hdd-class-iops', 'info'),
        'missing disk.hdd-class-iops');
    assert.ok(has(unknown, 'cpu', 'cpu.memory-skip'), 'missing cpu.memory-skip');

    const hdd = YabsRules.assess(m, { soldStorage: 'hdd' });
    assert.ok(has(hdd, 'disk', 'disk.sold-ok', 'ok'), 'missing disk.sold-ok for hdd');

    const ssd = YabsRules.assess(m, { soldStorage: 'ssd' });
    assert.ok(has(ssd, 'disk', 'disk.sold-mismatch', 'bad'),
        'missing bad disk.sold-mismatch for ssd');
    assert.strictEqual(ssd.overall, 'concerning');
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test('dd fallback: parsed and flagged, read side cached', () => {
    const m = parse('dd-fallback.txt');
    assert.strictEqual(m.disk.kind, 'dd');
    assert.ok(close(m.disk.dd.writeMBps, 180, 1), `dd write=${m.disk.dd.writeMBps}`);
    assert.ok(close(m.disk.dd.readMBps, 3500, 10), `dd read=${m.disk.dd.readMBps}`);
    const res = YabsRules.assess(m, {});
    assert.ok(has(res, 'disk', 'disk.dd-fallback', 'warn'), 'missing disk.dd-fallback');
    assert.ok(has(res, 'disk', 'disk.dd-read-cached', 'info'),
        'missing disk.dd-read-cached');
});

test('all busy: net.all-busy bad', () => {
    const m = parse('all-busy.txt');
    assert.strictEqual(m.iperf.IPv4.length, 7);
    const res = YabsRules.assess(m, {});
    assert.ok(has(res, 'network', 'net.all-busy', 'bad'), 'missing net.all-busy');
    assert.strictEqual(res.overall, 'concerning');
});

test('old format: no VM Type, no Ping column, KB/s units', () => {
    const m = parse('old-format.txt');
    assert.strictEqual(m.sys.vmType, null);
    assert.strictEqual(m.sys.virt, null);
    assert.strictEqual(m.iperf.IPv4.length, 4);
    for (const r of m.iperf.IPv4) assert.strictEqual(r.pingMs, null);
    assert.ok(close(m.disk.rows['4k'].totalMBps, 45.35, 0.01),
        `4k=${m.disk.rows['4k'].totalMBps}`);
    assert.strictEqual(m.disk.partition, null);
    const res = YabsRules.assess(m, {});
    assert.ok(res.derived.diskMedium, 'no disk medium derived');
});

test('upload capped: net.upload-capped', () => {
    const res = YabsRules.assess(parse('upload-capped.txt'), {});
    assert.ok(has(res, 'network', 'net.upload-capped', 'warn'),
        'missing net.upload-capped');
});

test('shaped port: net.shaped fires, no near-below-peak', () => {
    const res = YabsRules.assess(parse('shaped-port.txt'), {});
    assert.ok(has(res, 'network', 'net.shaped', 'info'), 'missing net.shaped');
    assert.ok(!has(res, 'network', 'net.near-below-peak'),
        'net.near-below-peak should not fire (near rows reach the observed peak)');
    assert.ok(has(res, 'network', 'net.port-delivered'), 'missing net.port-delivered');
});

test('ipv6 faster: net.ipv6-faster warn, no ipv6-slower', () => {
    const res = YabsRules.assess(parse('ipv6-faster.txt'), {});
    assert.ok(has(res, 'network', 'net.ipv6-faster', 'warn'),
        'missing net.ipv6-faster warn');
    assert.ok(!has(res, 'network', 'net.ipv6-slower'), 'unexpected net.ipv6-slower');
});

test('ipv6 all busy: net.ipv6-all-busy warn', () => {
    const res = YabsRules.assess(parse('ipv6-all-busy.txt'), {});
    assert.ok(has(res, 'network', 'net.ipv6-all-busy', 'warn'),
        'missing net.ipv6-all-busy');
});

test('throughput cap: QoS plateau, ssd-array, no iops-limited/mismatch', () => {
    const res = YabsRules.assess(parse('throughput-cap.txt'), {});
    assert.ok(has(res, 'disk', 'disk.throughput-cap', 'info'),
        'missing disk.throughput-cap');
    assert.strictEqual(res.derived.diskMedium, 'ssd-array');
    assert.ok(!has(res, 'disk', 'disk.iops-limited'),
        'disk.iops-limited should be suppressed by the cap');
    assert.ok(!has(res, 'disk', 'disk.inconsistent-cells'),
        'unexpected disk.inconsistent-cells');
});

test('mangled cells: disk.inconsistent-cells warn', () => {
    const res = YabsRules.assess(parse('mangled-cells.txt'), {});
    assert.ok(has(res, 'disk', 'disk.inconsistent-cells', 'warn'),
        'missing disk.inconsistent-cells');
});

test('gb failed low memory: gb-failed replaces memory-skip', () => {
    const m = parse('gb-failed-lowmem.txt');
    assert.ok(m.warnings.some(w => /low memory/i.test(w)), 'warning not captured');
    const res = YabsRules.assess(m, {});
    const gb = find(res, 'cpu', 'cpu.gb-failed');
    assert.ok(gb && gb.severity === 'info', 'missing cpu.gb-failed');
    assert.ok(/swap/i.test(gb.detail), 'gb-failed detail should mention swap');
    assert.ok(!has(res, 'cpu', 'cpu.memory-skip'),
        'cpu.memory-skip must not be emitted alongside cpu.gb-failed');
});

test('long runtime: ctx.long-runtime warn citing Geekbench', () => {
    const res = YabsRules.assess(parse('long-runtime.txt'), {});
    const lr = find(res, 'context', 'ctx.long-runtime');
    assert.ok(lr && lr.severity === 'warn', 'missing ctx.long-runtime warn');
    assert.ok(/Geekbench/.test(lr.detail), 'detail should cite Geekbench');
    assert.ok(has(res, 'cpu', 'cpu.single-band', 'warn'),
        'GB6 single 450 should be a warn band');
});

test('locale warning: ctx.locale-warning warn', () => {
    const m = parse('locale-warning.txt');
    const res = YabsRules.assess(m, {});
    assert.ok(has(res, 'context', 'ctx.locale-warning', 'warn'),
        'missing ctx.locale-warning');
});

test('link bound: net.remote-link-bound names Sao Paulo, not flagged slow', () => {
    const res = YabsRules.assess(parse('link-bound.txt'), {});
    const lb = find(res, 'network', 'net.remote-link-bound');
    assert.ok(lb && lb.severity === 'info', 'missing net.remote-link-bound');
    assert.ok(/Sao Paulo/.test(lb.title + ' ' + lb.detail),
        'link-bound finding should name Sao Paulo');
    const ols = find(res, 'network', 'net.one-location-slow');
    assert.ok(!ols || !/Sao Paulo/.test(ols.title + ' ' + ols.detail),
        'link-bound row must not be reported as the slow location');
});

test('no nearby server: info, no warn-level port finding', () => {
    const res = YabsRules.assess(parse('no-nearby.txt'), {});
    assert.ok(has(res, 'network', 'net.no-nearby-server', 'info'),
        'missing net.no-nearby-server');
    const portIds = ['net.port-partial', 'net.port-shortfall', 'net.near-below-peak'];
    assert.ok(!findings(res, 'network').some(x => portIds.includes(x.id) && x.severity === 'warn'),
        'no warn-level port finding expected when no server is nearby');
});

test('peak hours: 09 PM date line -> runHour 21, ctx.peak-hours', () => {
    const m = parse('peak-hours.txt');
    assert.strictEqual(m.runHour, 21);
    assert.strictEqual(m.runDate, '2025-03-14');
    assert.ok(has(YabsRules.assess(m, {}), 'context', 'ctx.peak-hours', 'info'),
        'missing ctx.peak-hours');
});

test('arm neoverse: arch inferred, disk.small-test-file', () => {
    const m = parse('arm-neoverse.txt');
    assert.strictEqual(m.sys.arch, 'arm');
    assert.ok(has(YabsRules.assess(m, {}), 'disk', 'disk.small-test-file', 'info'),
        'missing disk.small-test-file');
});

test('sysinfo-only paste: hasData but incomplete', () => {
    const m = parse('sysinfo-only.txt');
    assert.strictEqual(YabsParse.hasData(m), true);
    const res = YabsRules.assess(m, {});
    assert.strictEqual(res.overall, 'incomplete');
    assert.ok(has(res, 'disk', 'disk.skipped'), 'missing disk.skipped');
    assert.ok(has(res, 'network', 'net.skipped'), 'missing net.skipped');
    assert.ok(has(res, 'cpu', 'cpu.skipped'), 'missing cpu.skipped');
});

test('garbage input: no data -> incomplete', () => {
    const m = YabsParse.parse('hello');
    assert.strictEqual(YabsParse.hasData(m), false);
    assert.strictEqual(YabsRules.assess(m, {}).overall, 'incomplete');
});

test('forum junk around report still parses', () => {
    const junk = 'Check out my server!\n> quote from someone\n\n'
        + read('composite.txt') + '\n\nSent from my phone';
    const m = YabsParse.parse(junk);
    assert.strictEqual(m.version, 'v2026-10-31');
    assert.strictEqual(m.iperf.IPv4.length, 7);
    assert.strictEqual(m.disk.rows['4k'].totalIops, 22700);
});

test('wiki anchors: every finding wiki value resolves to a real page+anchor', () => {
    const wikiDir = '/home/mrowe/yet-another-bench-script/wiki';
    if (!fs.existsSync(wikiDir)) {
        console.log('     skip (wiki dir absent)');
        return;
    }
    const slug = s => s.trim().toLowerCase()
        .replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
    const anchors = {};
    for (const file of fs.readdirSync(wikiDir)) {
        if (!file.endsWith('.md')) continue;
        const set = new Set();
        for (const line of fs.readFileSync(path.join(wikiDir, file), 'utf8').split('\n')) {
            const h = line.match(/^#{1,6} (.*)$/);
            if (h) set.add(slug(h[1]));
        }
        anchors[file.replace(/\.md$/, '')] = set;
    }
    const ctxs = [{},
        { soldStorage: 'ssd', soldPortMbps: 1000, now: '2026-10-31' },
        { soldStorage: 'nvme', soldPortMbps: 100 }];
    const wikis = new Set();
    for (const name of fs.readdirSync(FIX)) {
        const m = parse(name);
        for (const ctx of ctxs) {
            const res = YabsRules.assess(m, ctx);
            for (const area of Object.values(res.areas)) {
                for (const x of area.findings) wikis.add(x.wiki);
            }
        }
    }
    assert.ok(wikis.size > 10, `suspiciously few wiki values collected: ${wikis.size}`);
    for (const w of wikis) {
        let page = 'Interpreting-Results', anchor = '';
        if (w.startsWith('#')) {
            anchor = w.slice(1);
        } else {
            const m2 = w.match(/\/wiki\/([^#]+)(?:#(.*))?$/);
            assert.ok(m2, `malformed wiki value: ${w}`);
            page = m2[1];
            anchor = m2[2] || '';
        }
        assert.ok(anchors[page], `wiki page missing for: ${w}`);
        if (anchor) assert.ok(anchors[page].has(anchor), `anchor missing: ${w}`);
    }
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
    for (const f of failures) console.log(`  - ${f.name}`);
    process.exit(1);
}
