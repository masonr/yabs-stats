'use strict';

// ---------------------------------------------------------------------------
// YABS output parser
// Raw report text or `-j` JSON -> normalized model. Pure functions, no DOM.
// ---------------------------------------------------------------------------

const YabsParse = (function () {

    const ANSI_RE = /\x1b(?:\[[0-9;?]*[a-zA-Z]|\][^\x07]*(?:\x07|\x1b\\)|[()][0-9A-B]|[=>])/g;
    const WARN_RE = /Warning!|Skipping|cannot run|Less than \d|download failed|binary .*fail|locale 'C' not detected|Both IPv4 AND IPv6|RISC-V compatibility|Geekbench.{0,40}test failed|low memory|only be downloaded over IPv4|requires tar|CentOS 7 and Geekbench|fio disk speed tests failed/i;

    function emptyModel(format) {
        return {
            format: format,
            version: null,
            date: null,
            sys: {
                uptimeSec: null, cpuModel: null, cores: null, mhz: null,
                aes: null, virt: null,
                ramGiB: null, swapGiB: null, diskGiB: null,
                distro: null, kernel: null, vmType: null,
                ipv4: null, ipv6: null, arch: null,
            },
            runHour: null,
            runDate: null,
            ipinfo: null,
            disk: { kind: null, partition: null, zfsWarning: false, rows: {}, dd: null },
            iperf: { IPv4: [], IPv6: [] },
            geekbench: [],
            runtimeSec: null,
            warnings: [],
        };
    }

    // -----------------------------------------------------------------------
    // Unit helpers
    // -----------------------------------------------------------------------

    function sizeToGiB(str) {
        const m = String(str).trim().match(/^([\d.]+)\s*(TiB|GiB|MiB|KiB|TB|GB|MB|KB|B)$/i);
        if (!m) return null;
        const v = parseFloat(m[1]);
        if (isNaN(v)) return null;
        switch (m[2].toUpperCase()) {
            case 'TIB': return v * 1024;
            case 'GIB': return v;
            case 'MIB': return v / 1024;
            case 'KIB': return v / 1048576;
            case 'TB':  return v * 1e12 / Math.pow(2, 30);
            case 'GB':  return v * 1e9 / Math.pow(2, 30);
            case 'MB':  return v * 1e6 / Math.pow(2, 30);
            case 'KB':  return v * 1e3 / Math.pow(2, 30);
            case 'B':   return v / Math.pow(2, 30);
        }
        return null;
    }

    function speedToMBps(str) {
        const m = String(str).trim().match(/^([\d.]+)\s*([KMGTP]?B)\/s/i);
        if (!m) return null;
        const v = parseFloat(m[1]);
        if (isNaN(v)) return null;
        switch (m[2].toUpperCase()) {
            case 'GB': return v * 1000;
            case 'TB': return v * 1e6;
            case 'PB': return v * 1e9;
            case 'KB': return v / 1000;
            case 'B':  return v / 1e6;
            default:   return v;
        }
    }

    function bitsToMbps(str) {
        const m = String(str).trim().match(/^([\d.]+)\s*([KMGT]?)bits?\/sec/i);
        if (!m) return null;
        const v = parseFloat(m[1]);
        if (isNaN(v)) return null;
        switch (m[2].toUpperCase()) {
            case 'K': return v / 1000;
            case 'G': return v * 1000;
            case 'T': return v * 1e6;
            case '':  return v / 1e6;
            default:  return v;
        }
    }

    function iopsValue(str) {
        const m = String(str).trim().match(/^([\d.]+)\s*([kK])?$/);
        if (!m) return null;
        const v = parseFloat(m[1]);
        return isNaN(v) ? null : v * (m[2] ? 1000 : 1);
    }

    function onOff(str) {
        if (/disabled|offline/i.test(str)) return false;
        if (/enabled|online/i.test(str)) return true;
        return null;
    }

    // -----------------------------------------------------------------------
    // Cell parsers
    // -----------------------------------------------------------------------

    function parseFioCell(cell) {
        const m = cell.trim().match(/([\d.]+)\s*([KMGTP]?B)\/s\s*(?:\(([^)]*)\))?/i);
        if (!m) return null;
        return { mbps: speedToMBps(m[1] + ' ' + m[2] + '/s'), iops: m[3] ? iopsValue(m[3]) : null };
    }

    function parseSpeedCell(cell) {
        const t = String(cell == null ? '' : cell).trim();
        if (!t || /^busy$/i.test(t)) return { mbps: null, busy: true };
        const v = bitsToMbps(t);
        if (v === null || v === 0) return { mbps: null, busy: true };
        return { mbps: v, busy: false };
    }

    function parsePingCell(cell) {
        const t = String(cell == null ? '' : cell).trim();
        if (!t || t === '--') return null;
        const m = t.match(/^([\d.]+)\s*ms/i);
        return m ? parseFloat(m[1]) : null;
    }

    function parseUptime(str) {
        const d = str.match(/([\d.]+)\s*day/i);
        const h = str.match(/([\d.]+)\s*hour/i);
        const m = str.match(/([\d.]+)\s*min/i);
        const s = str.match(/([\d.]+)\s*sec/i);
        if (!d && !h && !m && !s) {
            const bare = str.match(/^([\d.]+)$/);
            return bare ? parseFloat(bare[1]) : null;
        }
        return (d ? parseFloat(d[1]) * 86400 : 0)
             + (h ? parseFloat(h[1]) * 3600 : 0)
             + (m ? parseFloat(m[1]) * 60 : 0)
             + (s ? parseFloat(s[1]) : 0);
    }

    const MONTHS = {
        jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
        jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
    };

    function parseDateLine(str) {
        const out = { runHour: null, runDate: null };
        const tm = str.match(/(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)?/i);
        if (tm) {
            let h = parseInt(tm[1], 10);
            const ap = (tm[4] || '').toUpperCase();
            if (ap === 'AM' && h === 12) h = 0;
            else if (ap === 'PM' && h < 12) h += 12;
            if (h >= 0 && h <= 23) out.runHour = h;
        }
        const mm = str.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2})/);
        const ym = str.match(/\b(20\d{2})\b/);
        if (mm && ym) {
            const mon = MONTHS[mm[1].toLowerCase().slice(0, 3)];
            const day = parseInt(mm[2], 10);
            if (mon && day >= 1 && day <= 31) {
                out.runDate = `${ym[1]}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            }
        }
        return out;
    }

    function parseJsonTime(str) {
        const m = String(str || '').match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/);
        if (!m) return { runHour: null, runDate: null };
        return {
            runHour: parseInt(m[4], 10),
            runDate: `${m[1]}-${m[2]}-${m[3]}`,
        };
    }

    const ARCH_ARM_RE = /Neoverse|Ampere|Cortex|Graviton|Apple M|Kunpeng|Snapdragon|\bARM\b/i;
    const ARCH_RISCV_RE = /RISC-V|rv64|SiFive|T-Head|StarFive|Spacemit/i;

    function inferArch(cpuModel) {
        if (!cpuModel) return null;
        if (ARCH_ARM_RE.test(cpuModel)) return 'arm';
        if (ARCH_RISCV_RE.test(cpuModel)) return 'riscv';
        return null;
    }

    function mapJsonArch(a) {
        switch (a) {
            case 'x64': return 'x64';
            case 'x86': return 'x86';
            case 'aarch64':
            case 'arm': return 'arm';
            case 'riscv64': return 'riscv';
        }
        return null;
    }

    function parseRuntime(str) {
        const m = str.match(/completed in\s+(?:(\d+)\s*hr?s?\s*)?(?:(\d+)\s*min\s*)?(?:(\d+)\s*sec)?/i);
        if (!m || (!m[1] && !m[2] && !m[3])) return null;
        return (m[1] ? +m[1] * 3600 : 0) + (m[2] ? +m[2] * 60 : 0) + (m[3] ? +m[3] : 0);
    }

    // -----------------------------------------------------------------------
    // Text report parser
    // -----------------------------------------------------------------------

    const SECTIONS = [
        { re: /^Basic System Information/, sec: 'sys' },
        { re: /^(?:IPv4|IPv6)?\s*Network Information/, sec: 'ipinfo' },
        { re: /^fio Disk Speed Tests/, sec: 'fio' },
        { re: /^dd Sequential Disk Speed Tests/, sec: 'dd' },
        { re: /^iperf3 Network Speed Tests/, sec: 'iperf' },
        { re: /^Geekbench \d Benchmark Test/, sec: 'gb' },
    ];

    function parseText(text) {
        const model = emptyModel('text');
        let section = null;
        let gb = null;
        let fioBs = [];
        let ipver = 'IPv4';
        let iperfHasPing = true;
        const ipinfo = {};

        for (const raw of text.split('\n')) {
            const t = raw.trim();
            if (!t) continue;

            if (WARN_RE.test(t)) model.warnings.push(t);
            if (/running YABS on a ZFS Filesystem/i.test(t)) model.disk.zfsWarning = true;
            if (/^Less than \d+\s*(GB|MB) of space available/i.test(t)) model.disk.kind = 'skipped';

            if (model.version === null && t[0] === '#') {
                const vm = t.match(/v\d{4}-\d{2}-\d{2}/);
                if (vm) model.version = vm[0];
            }
            if (model.date === null
                && /^[A-Z][a-z]{2} [A-Z][a-z]{2} +\d{1,2} \d{1,2}:\d{2}:\d{2}/.test(t)) {
                model.date = t;
                const dp = parseDateLine(t);
                model.runHour = dp.runHour;
                model.runDate = dp.runDate;
            }

            const rt = t.match(/^YABS completed in/i);
            if (rt) { model.runtimeSec = parseRuntime(t); section = null; continue; }

            let matched = false;
            for (const s of SECTIONS) {
                if (s.re.test(t)) {
                    matched = true;
                    if (s.sec === 'fio') {
                        const pm = t.match(/\(Partition\s+([^)]+)\)/);
                        model.disk.kind = 'fio';
                        model.disk.partition = pm ? pm[1].trim() : null;
                        model.disk.dd = null;
                        fioBs = [];
                    } else if (s.sec === 'dd') {
                        model.disk.kind = 'dd';
                        model.disk.dd = { writeMBps: null, readMBps: null };
                    } else if (s.sec === 'iperf') {
                        const mm = t.match(/\((IPv4|IPv6)\)/);
                        ipver = mm ? mm[1] : 'IPv4';
                        section = 'iperf';
                        iperfHasPing = true;
                    } else if (s.sec === 'gb') {
                        gb = {
                            version: parseInt(t.match(/\d/)[0], 10),
                            single: null, multi: null, url: null,
                        };
                        model.geekbench.push(gb);
                    }
                    section = s.sec;
                    break;
                }
            }
            if (matched) continue;
            if (/^-+$/.test(t) || t[0] === '#') continue;

            if (section === 'sys') {
                const kv = t.match(/^([A-Za-z][A-Za-z0-9\-x\/ ]*?)\s*:\s*(.+)$/);
                if (!kv) continue;
                const label = kv[1].trim(), val = kv[2].trim();
                if (label === 'Uptime') model.sys.uptimeSec = parseUptime(val);
                else if (label === 'Processor' || label === 'CPU Model') model.sys.cpuModel = val;
                else if (label === 'CPU cores') {
                    const cm = val.match(/(\d+)\s*@\s*(\S+)/);
                    if (cm) {
                        model.sys.cores = parseInt(cm[1], 10);
                        model.sys.mhz = cm[2].indexOf('?') >= 0 ? null : parseFloat(cm[2]);
                    }
                } else if (label === 'AES-NI') model.sys.aes = onOff(val);
                else if (/^VM-x\/AMD-V|^Virtuali[sz]ation/.test(label)) model.sys.virt = onOff(val);
                else if (label === 'RAM') model.sys.ramGiB = sizeToGiB(val);
                else if (label === 'Swap') model.sys.swapGiB = sizeToGiB(val);
                else if (label === 'Disk') model.sys.diskGiB = sizeToGiB(val);
                else if (label === 'Distro') model.sys.distro = val;
                else if (label === 'Kernel') model.sys.kernel = val;
                else if (label === 'VM Type') model.sys.vmType = val;
                else if (label === 'IPv4/IPv6') {
                    const parts = val.split('/');
                    model.sys.ipv4 = onOff(parts[0]);
                    model.sys.ipv6 = parts.length > 1 ? onOff(parts[1]) : null;
                }
            } else if (section === 'ipinfo') {
                const kv = t.match(/^([A-Za-z ]+?)\s*:\s*(.+)$/);
                if (!kv) continue;
                const label = kv[1].trim(), val = kv[2].trim();
                if (label === 'ISP') ipinfo.isp = val;
                else if (label === 'ASN') ipinfo.asn = val;
                else if (label === 'Host' || label === 'Organization') ipinfo.org = val;
                else if (label === 'Location') {
                    const li = val.indexOf(',');
                    ipinfo.city = li >= 0 ? val.slice(0, li).trim() : val;
                    ipinfo.region = li >= 0 ? val.slice(li + 1).trim() : null;
                } else if (label === 'Country') ipinfo.country = val;
            } else if (section === 'fio') {
                if (/^Block Size/.test(t)) {
                    fioBs = t.split('|').slice(1)
                        .map(c => c.trim().split(/\s+/)[0]).filter(Boolean);
                    continue;
                }
                const rm = t.match(/^(Read|Write|Total)\s*\|(.*)$/);
                if (!rm || !fioBs.length) continue;
                const cells = rm[2].split('|');
                const dir = rm[1].toLowerCase();
                fioBs.forEach((bs, i) => {
                    const p = cells[i] ? parseFioCell(cells[i]) : null;
                    if (!p) return;
                    const row = model.disk.rows[bs] = model.disk.rows[bs] || {};
                    row[dir + 'MBps'] = p.mbps;
                    row[dir + 'Iops'] = p.iops;
                });
            } else if (section === 'dd') {
                const dm = t.match(/^(Write|Read)\s*\|(.*)$/);
                if (!dm || !model.disk.dd) continue;
                const cells = dm[2].split('|').map(c => c.trim()).filter(Boolean);
                if (!cells.length) continue;
                model.disk.dd[dm[1].toLowerCase() + 'MBps'] = speedToMBps(cells[cells.length - 1]);
            } else if (section === 'iperf') {
                const cells = t.split('|').map(c => c.trim());
                if (/^Provider/.test(cells[0])) {
                    iperfHasPing = cells.length >= 5;
                    continue;
                }
                if (/^-+$/.test(cells[0]) || cells.length < 4) continue;
                const send = parseSpeedCell(cells[2]);
                const recv = parseSpeedCell(cells[3]);
                const lm = cells[1].match(/\((\d+(?:\.\d+)?)G\)\s*$/);
                model.iperf[ipver].push({
                    provider: cells[0],
                    loc: cells[1],
                    linkGbps: lm ? parseFloat(lm[1]) : null,
                    sendMbps: send.mbps, recvMbps: recv.mbps,
                    pingMs: iperfHasPing ? parsePingCell(cells[4]) : null,
                    sendBusy: send.busy, recvBusy: recv.busy,
                });
            } else if (section === 'gb') {
                const gkv = t.match(/^(Single Core|Multi Core|Full Test)\s*\|(.+)$/);
                if (!gkv || !gb) continue;
                const val = gkv[2].trim();
                if (gkv[1] === 'Full Test') gb.url = /^https?:\/\//.test(val) ? val : null;
                else {
                    const num = val.match(/^\d+(?:\.\d+)?$/);
                    gb[gkv[1] === 'Single Core' ? 'single' : 'multi'] = num ? parseFloat(val) : null;
                }
            }
        }

        if (Object.keys(ipinfo).length) model.ipinfo = ipinfo;
        if (!model.disk.kind && model.warnings.some(w => /Skipping disk/i.test(w))) {
            model.disk.kind = 'skipped';
        }
        model.sys.arch = inferArch(model.sys.cpuModel);
        return model;
    }

    // -----------------------------------------------------------------------
    // JSON (-j/-w/-s) parser
    // -----------------------------------------------------------------------

    function parseJSON(text) {
        const model = emptyModel('json');
        let j;
        try { j = JSON.parse(text); } catch (e) { return model; }
        if (!j || typeof j !== 'object') return model;

        model.version = j.version || null;
        model.date = j.time || null;
        const os = j.os || {}, cpu = j.cpu || {}, mem = j.mem || {}, net = j.net || {};

        model.sys.uptimeSec = typeof os.uptime === 'number' ? os.uptime : null;
        model.sys.distro = os.distro || null;
        model.sys.kernel = os.kernel || null;
        model.sys.vmType = os.vm || null;
        model.sys.cpuModel = cpu.model || null;
        model.sys.cores = typeof cpu.cores === 'number' ? cpu.cores : null;
        if (typeof cpu.freq === 'string') {
            model.sys.mhz = cpu.freq.indexOf('?') >= 0 ? null : parseFloat(cpu.freq);
            if (isNaN(model.sys.mhz)) model.sys.mhz = null;
        }
        model.sys.aes = typeof cpu.aes === 'boolean' ? cpu.aes : null;
        model.sys.virt = typeof cpu.virt === 'boolean' ? cpu.virt : null;
        model.sys.ramGiB = typeof mem.ram === 'number' ? mem.ram / 1048576 : null;
        model.sys.swapGiB = typeof mem.swap === 'number' ? mem.swap / 1048576 : null;
        model.sys.diskGiB = typeof mem.disk === 'number' ? mem.disk / 1048576 : null;
        model.sys.ipv4 = typeof net.ipv4 === 'boolean' ? net.ipv4 : null;
        model.sys.ipv6 = typeof net.ipv6 === 'boolean' ? net.ipv6 : null;
        model.sys.arch = mapJsonArch(os.arch);
        if (model.sys.arch === null) model.sys.arch = inferArch(model.sys.cpuModel);
        const dt = parseJsonTime(j.time);
        model.runHour = dt.runHour;
        model.runDate = dt.runDate;

        if (j.ip_info && typeof j.ip_info === 'object') {
            model.ipinfo = {
                isp: j.ip_info.isp || null,
                asn: j.ip_info.asn || null,
                org: j.ip_info.org || null,
                city: j.ip_info.city || null,
                region: j.ip_info.region || null,
                country: j.ip_info.country || null,
            };
        }

        if (Array.isArray(j.fio) && j.fio.length) {
            model.disk.kind = 'fio';
            model.disk.partition = j.partition || null;
            for (const e of j.fio) {
                if (!e || !e.bs) continue;
                const kib = v => typeof v === 'number' ? v * 1024 / 1e6 : null;
                model.disk.rows[e.bs] = {
                    readMBps: kib(e.speed_r), writeMBps: kib(e.speed_w), totalMBps: kib(e.speed_rw),
                    readIops: e.iops_r || null, writeIops: e.iops_w || null, totalIops: e.iops_rw || null,
                };
            }
        } else if (j.fio === undefined || (Array.isArray(j.fio) && !j.fio.length)) {
            model.disk.kind = 'skipped';
            model.disk.partition = j.partition || null;
        }

        if (Array.isArray(j.iperf)) {
            for (const e of j.iperf) {
                if (!e || typeof e !== 'object') continue;
                const mode = e.mode === 'IPv6' ? 'IPv6' : 'IPv4';
                const send = parseSpeedCell(e.send);
                const recv = parseSpeedCell(e.recv);
                const loc = e.loc || '';
                const lm = loc.match(/\((\d+(?:\.\d+)?)G\)\s*$/);
                model.iperf[mode].push({
                    provider: e.provider || '',
                    loc: loc,
                    linkGbps: lm ? parseFloat(lm[1]) : null,
                    sendMbps: send.mbps, recvMbps: recv.mbps,
                    pingMs: parsePingCell(e.latency),
                    sendBusy: send.busy, recvBusy: recv.busy,
                });
            }
        }

        if (Array.isArray(j.geekbench)) {
            for (const e of j.geekbench) {
                if (!e || typeof e !== 'object') continue;
                model.geekbench.push({
                    version: typeof e.version === 'number' ? e.version : null,
                    single: typeof e.single === 'number' ? e.single : null,
                    multi: typeof e.multi === 'number' ? e.multi : null,
                    url: e.url || null,
                });
            }
        }

        if (j.runtime && typeof j.runtime.elapsed === 'number') {
            model.runtimeSec = j.runtime.elapsed;
        }
        return model;
    }

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------

    function parse(text) {
        let t = typeof text === 'string' ? text : String(text == null ? '' : text);
        t = t.replace(ANSI_RE, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        return /^\s*{/.test(t) ? parseJSON(t) : parseText(t);
    }

    function hasData(model) {
        if (!model) return false;
        return !!(Object.keys(model.disk.rows || {}).length
            || (model.disk.dd && (model.disk.dd.writeMBps != null || model.disk.dd.readMBps != null))
            || model.iperf.IPv4.length || model.iperf.IPv6.length
            || model.geekbench.length || model.sys.cpuModel);
    }

    return { parse: parse, hasData: hasData };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = YabsParse;
