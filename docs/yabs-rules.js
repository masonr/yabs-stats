'use strict';

// ---------------------------------------------------------------------------
// YABS result rules engine
// Normalized model (+ optional user context) -> assessment. Pure, no DOM.
// Wiki anchors refer to wiki/Interpreting-Results.md unless a full URL is used.
// ---------------------------------------------------------------------------

const YabsRules = (function () {

    const WIKI_BASE = 'https://github.com/masonr/yet-another-bench-script/wiki/Interpreting-Results';
    const WIKI = 'https://github.com/masonr/yet-another-bench-script/wiki/';
    const SNAP_URL = WIKI + 'Benchmarks-Are-Snapshots';
    const TN = WIKI + 'Tests-Network-iperf3';
    const TD = WIKI + 'Tests-Disk-fio';
    const TC = WIKI + 'Tests-CPU-Geekbench';
    const TF = WIKI + 'Troubleshooting-and-FAQ';
    const UO = WIKI + 'Understanding-the-Output';
    const BS = WIKI + 'Benchmarks-Are-Snapshots';

    const A_SYS = '#start-with-the-system-information-block';
    const A_FINGER = '#storage-class-fingerprints';
    const A_CACHE = '#caching-and-other-sources-of-inflated-numbers';
    const A_QOS = '#throttling-and-qos-limits';
    const A_ZFS = '#the-zfs-warning-and-other-reasons-the-disk-test-can-mislead';
    const A_NET = '#network-reading-the-iperf3-table';
    const A_CEIL = '#practical-ceilings-by-port-speed';
    const A_DIST = '#distance-latency-and-why-far-away-numbers-are-lower';
    const A_PAT = '#patterns-worth-noticing';
    const A_CPU = '#cpu-reading-the-geekbench-scores';
    const A_LAND = '#orientation-geekbench-6-single-core-landmarks';

    function f(id, severity, title, detail, wiki) {
        return { id: id, severity: severity, title: title, detail: detail, wiki: wiki };
    }

    const SEV_ORDER = { bad: 0, warn: 1, ok: 2, info: 3 };

    function sortFindings(findings) {
        findings.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
        return findings;
    }

    function median(nums) {
        const a = nums.slice().sort((x, y) => x - y);
        const mid = a.length >> 1;
        return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
    }

    function fmtInt(n) {
        return n == null ? '?' : Math.round(n).toLocaleString('en-US');
    }

    function fmtPort(mbps) {
        if (mbps == null) return '?';
        if (mbps % 1000 === 0) return (mbps / 1000) + ' Gbit/s';
        if (mbps > 1000) return (mbps / 1000) + ' Gbit/s';
        return mbps + ' Mbit/s';
    }

    function rowBest(r) {
        return Math.max(r.sendMbps || 0, r.recvMbps || 0);
    }

    // -----------------------------------------------------------------------
    // Disk
    // -----------------------------------------------------------------------

    function assessDisk(model, ctx, derived) {
        const findings = [];
        const d = model.disk || {};
        const rows = d.rows || {};
        const r4 = rows['4k'], r64 = rows['64k'], r1 = rows['1m'];
        const I4 = r4 ? r4.totalIops : null;
        const T1 = r1 ? r1.totalMBps : null;
        const T64 = r64 ? r64.totalMBps : null;
        const I64 = r64 ? r64.totalIops : null;
        let headline = null;
        let medium = null, label = null;

        derived.iops4k = I4;
        derived.iops64k = I64;
        derived.tput1m = T1;
        derived.tput64k = T64;

        if (!d.kind || d.kind === 'skipped') {
            findings.push(f('disk.skipped', 'info', 'Disk test skipped',
                'Less than 2 GB free, `-f`, or an error — no storage verdict.', TF + '#disk-test'));
            return { headline: headline, findings: sortFindings(findings) };
        }
        if (d.kind === 'dd') {
            findings.push(f('disk.dd-fallback', 'warn', 'fio fell back to dd',
                'fio could not run; dd numbers are single-threaded sequential with a ' +
                'cache-inflated read side — not comparable to fio tables.', TD + '#the-dd-fallback'));
            const dd = d.dd || {};
            if (dd.readMBps != null && dd.writeMBps != null && dd.writeMBps > 0
                && dd.readMBps / dd.writeMBps >= 3) {
                findings.push(f('disk.dd-read-cached', 'info',
                    'dd read side is page-cache inflated',
                    `Only the write figure (${Math.round(dd.writeMBps)} MB/s, direct I/O) is ` +
                    'honest; the 1 GiB file was just written and is served from RAM.',
                    TD + '#the-dd-fallback'));
            }
            return { headline: 'dd sequential numbers only', findings: sortFindings(findings) };
        }
        if (d.zfsWarning) {
            findings.push(f('disk.zfs-warning', 'bad', 'ZFS free-space warning',
                'Results can be up to 10× too low; treat these disk numbers as invalid.', A_ZFS));
            return { headline: 'Disk results invalid (ZFS warning)', findings: sortFindings(findings) };
        }

        if (T1 != null) {
            if (T1 < 250) {
                medium = 'hdd';
                label = I4 != null && I4 < 400 ? 'single spinning disk'
                      : I4 != null && I4 < 2000 ? 'HDD RAID (several spindles)'
                      : 'HDD-class streaming';
            } else if (T1 < 600) {
                medium = 'sata';
                label = 'SATA SSD (or multi-spindle HDD RAID)';
            } else if (T1 < 1500) {
                medium = 'ssd-array';
                label = 'SSD RAID / enterprise SSD / fast network storage';
            } else if (T1 < 3000) {
                medium = 'nvme';
                label = 'NVMe (PCIe 3 class)';
            } else {
                medium = 'nvme-fast';
                label = 'NVMe (PCIe 4/5 or large array)';
            }
        }

        const setHeadline = function () {
            headline = medium
                ? `Consistent with ${label} — ${fmtInt(I4)} 4k IOPS, ${fmtInt(T1)} MB/s at 1m`
                : `fio result — ${fmtInt(I4)} 4k IOPS (no 1m row parsed)`;
        };
        setHeadline();
        derived.diskMedium = medium;
        derived.diskMediumLabel = label;

        // a flat throughput line across block sizes is a QoS cap, not the medium
        const T4k = r4 ? r4.totalMBps : null;
        const tpVals = [T4k, T64, T1].filter(v => v != null);
        const tpCap = !!(r4 && r64 && r1 && I4 != null && I4 >= 10000
            && Math.min.apply(null, tpVals) >= 0.90 * Math.max.apply(null, tpVals));
        if (tpCap) {
            findings.push(f('disk.throughput-cap', 'info',
                'Throughput identical at every block size',
                'A per-volume bandwidth cap (QoS) is the ceiling, not the medium — ' +
                'typical of cloud block volumes.', A_QOS));
        }

        // cross-check 4k IOPS against the streaming class
        if (medium && I4 != null) {
            if (medium === 'hdd') {
                if (I4 >= 10000) {
                    findings.push(f('disk.cache-signature', 'warn',
                        '4k IOPS far above what spinning disks do',
                        '1m throughput is HDD-class — a write-back / RAID / ZFS cache is ' +
                        'absorbing small I/O. Headline IOPS will not hold under sustained load.',
                        A_CACHE));
                } else if (I4 >= 2000) {
                    findings.push(f('disk.hdd-array-or-cache', 'info',
                        'IOPS above a few spindles',
                        'Larger HDD array or a modest cache.', A_CACHE));
                }
            } else if (medium === 'sata') {
                if (I4 < 2000) {
                    medium = 'hdd-raid';
                    label = 'multi-spindle HDD RAID (or heavily contended SSD)';
                    derived.diskMedium = medium;
                    derived.diskMediumLabel = label;
                    setHeadline();
                    findings.push(f('disk.hdd-class-iops', 'info',
                        'Streaming is SSD/array class but 4k IOPS are HDD-class',
                        'Fine for a storage plan, wrong for anything sold as SSD.', A_FINGER));
                } else if (I4 > 150000) {
                    findings.push(f('disk.iops-above-class', 'info',
                        '4k IOPS above SATA class',
                        'NVMe behind a throughput cap, or a cache.', A_QOS));
                }
            } else if (medium === 'ssd-array') {
                if (I4 < 10000 && !tpCap) {
                    findings.push(f('disk.iops-limited', 'warn',
                        'Throughput says SSD/array but 4k IOPS are modest and flat',
                        'Network block storage or a per-volume IOPS limit.', A_QOS));
                }
            } else if (medium === 'nvme' || medium === 'nvme-fast') {
                if (I4 < 50000) {
                    findings.push(f('disk.iops-limited', 'warn',
                        '1m throughput is NVMe-class but 4k IOPS are low for NVMe',
                        'Signature of shared NVMe with an IOPS limit or heavy neighbour load.',
                        A_QOS));
                }
            }
            if (medium !== 'hdd' && medium !== 'hdd-raid' && I4 < 1000) {
                findings.push(f('disk.iops-red-flag', 'bad',
                    'Under 1,000 4k IOPS on SSD-class throughput',
                    'Contention, throttling, or misdescription.', A_FINGER));
            }
        }

        if (T64 != null && T1 != null && T1 < 0.9 * T64) {
            findings.push(f('disk.throughput-falls', 'warn',
                'Throughput drops from 64k to 1m',
                'HDD-class streaming behind a cache.', A_CACHE));
        }

        const asym = [];
        for (const bs of ['4k', '64k', '512k', '1m']) {
            const r = rows[bs];
            if (!r || !(r.readMBps > 0) || !(r.writeMBps > 0)) continue;
            const ratio = r.readMBps / r.writeMBps;
            if (ratio >= 2) asym.push(`reads ≫ writes at ${bs} (read cache or write throttling)`);
            else if (ratio <= 0.5) asym.push(`writes ≫ reads at ${bs} (write-back cache absorbing writes)`);
        }
        if (asym.length) {
            findings.push(f('disk.rw-asymmetry', 'warn', 'Read/write asymmetry',
                asym.join('; ') + '.', A_CACHE));
        }

        // bw ≈ IOPS × block size must hold; a big mismatch means mangled numbers
        const BS_BYTES = { '4k': 4096, '64k': 65536, '512k': 524288, '1m': 1048576 };
        for (const bs of ['4k', '64k', '512k', '1m']) {
            const r = rows[bs];
            if (!r || r.totalMBps == null || !(r.totalIops > 0)) continue;
            const expected = r.totalIops * BS_BYTES[bs] / 1e6;
            if (Math.abs(r.totalMBps - expected) / expected > 0.15) {
                findings.push(f('disk.inconsistent-cells', 'warn',
                    `Throughput and IOPS disagree at ${bs}`,
                    'bw ≈ IOPS × block size should hold; a mismatch means mangled numbers ' +
                    '(missing C locale / decimal commas, or a copy-paste error). ' +
                    'Treat the disk verdict with caution.',
                    TD + '#the-arithmetic-of-one-block-size-run'));
            }
        }

        const arch = (model.sys && model.sys.arch) || null;
        if (arch === 'arm' || arch === 'riscv') {
            findings.push(f('disk.small-test-file', 'info',
                '512 MiB test file on ARM/RISC-V',
                'A quarter of the x86 file size — fits in host caches more easily, ' +
                'so inflated numbers are more likely.', TD + '#every-parameter-and-why'));
        }

        if (I4 != null && I64 != null && I4 >= 1000 && Math.abs(I4 - I64) / I4 < 0.10) {
            findings.push(f('disk.iops-plateau', 'info',
                'Nearly identical IOPS at 4k and 64k',
                'A per-volume IOPS cap (QoS) rather than the medium.', A_QOS));
        }

        const hddClass = medium === 'hdd' || medium === 'hdd-raid';
        if (ctx.soldStorage && ctx.soldStorage !== 'unknown' && medium) {
            if (ctx.soldStorage === 'nvme' && (hddClass || medium === 'sata')) {
                findings.push(f('disk.sold-mismatch', 'bad',
                    `Sold as NVMe; behaves like ${label}`, '', A_FINGER));
            } else if (ctx.soldStorage === 'nvme' && medium === 'ssd-array') {
                findings.push(f('disk.sold-mismatch', 'warn',
                    `Sold as NVMe; behaves like ${label}`, '', A_FINGER));
            } else if (ctx.soldStorage === 'ssd' && hddClass) {
                findings.push(f('disk.sold-mismatch', 'bad',
                    `Sold as SSD; behaves like ${label}`, '', A_FINGER));
            } else if (ctx.soldStorage === 'hdd' && hddClass) {
                findings.push(f('disk.sold-ok', 'ok',
                    'Performs as a hard-disk plan should.', '', A_FINGER));
            } else {
                findings.push(f('disk.sold-ok', 'ok', 'Matches what was sold.', '', A_FINGER));
            }
        }

        if (d.partition) {
            findings.push(f('disk.partition', 'info', `Tested partition ${d.partition}`,
                'The disk under the directory YABS ran from.',
                TD + '#testing-a-different-disk-or-partition'));
        }

        if (medium && !findings.some(x => x.severity === 'warn' || x.severity === 'bad')) {
            findings.push(f('disk.ok', 'ok',
                '4k and 1m agree on a storage class', 'Read/write symmetric.', A_FINGER));
        }

        return { headline: headline, findings: sortFindings(findings) };
    }

    // -----------------------------------------------------------------------
    // Network
    // -----------------------------------------------------------------------

    function assessNet(model, ctx, derived) {
        const findings = [];
        const v4 = (model.iperf && model.iperf.IPv4) || [];
        const v6 = (model.iperf && model.iperf.IPv6) || [];
        const rows = v4.length ? v4 : v6;
        let headline = null;

        if (!rows.length) {
            findings.push(f('net.skipped', 'info', 'No iperf3 results',
                'The network tests were skipped or produced no rows.', TF + '#by-symptom'));
            return { headline: headline, findings: sortFindings(findings) };
        }

        if (rows.every(r => r.sendBusy && r.recvBusy)) {
            findings.push(f('net.all-busy', 'bad', 'Every server reported busy',
                'Outbound firewall blocking 5200–5210 / 9204–9240, a NAT VPS with restricted ' +
                'ports, or no outbound connectivity. This says nothing about the provider\'s port.',
                TN + '#firewalls-and-busy'));
            return { headline: headline, findings: sortFindings(findings) };
        }

        if ((model.sys && model.sys.ipv6 === true) && v6.length
            && v6.every(r => r.sendBusy && r.recvBusy)
            && v4.some(r => !r.sendBusy || !r.recvBusy)) {
            findings.push(f('net.ipv6-all-busy', 'warn',
                'IPv6 connectivity detected but every IPv6 test failed',
                'Broken IPv6 routing, MTU/fragmentation problems on the provider side, ' +
                'or a v6-only firewall rule.', A_PAT));
        }

        const busyCells = rows.reduce((n, r) => n + (r.sendBusy ? 1 : 0) + (r.recvBusy ? 1 : 0), 0);
        derived.busyCells = busyCells;
        if (busyCells / (rows.length * 2) >= 0.5) {
            findings.push(f('net.many-busy', 'info',
                'Half or more of the tests were busy',
                'Far-end saturation; re-run at another hour.', '#what-the-columns-mean'));
        }

        let peak = 0, peakRow = null, peakDir = null;
        for (const r of rows) {
            if (!r.sendBusy && r.sendMbps != null && r.sendMbps > peak) {
                peak = r.sendMbps; peakRow = r; peakDir = 'send';
            }
            if (!r.recvBusy && r.recvMbps != null && r.recvMbps > peak) {
                peak = r.recvMbps; peakRow = r; peakDir = 'recv';
            }
        }
        derived.peakMbps = peak || null;

        const CEILINGS = [[94, 100], [950, 1000], [2400, 2500], [9500, 10000]];
        let inferred = 25000;
        for (const c of CEILINGS) {
            if (peak <= c[0]) { inferred = c[1]; break; }
        }
        derived.inferredPortMbps = inferred;
        const sold = ctx.soldPortMbps || null;
        const port = sold || inferred;
        derived.portMbps = port;

        if (peakRow) {
            headline = `Peak ${fmtInt(peak)} Mbit/s to ${peakRow.provider}, ${peakRow.loc} ` +
                `(${peakDir}) — ` +
                (sold ? `on a ${fmtPort(sold)} port` : `at least a ${fmtPort(inferred)} port`);
        }

        // nearest servers carry the verdict
        const pinged = rows.filter(r => r.pingMs != null).sort((a, b) => a.pingMs - b.pingMs);
        let near;
        if (pinged.length) {
            near = pinged.filter(r => r.pingMs < 20);
            if (!near.length) near = pinged.slice(0, Math.min(2, pinged.length));
        } else {
            near = rows.slice().sort((a, b) => rowBest(b) - rowBest(a))
                .slice(0, Math.min(2, rows.length));
        }
        const nearSet = new Set(near);
        let nearBest = 0;
        for (const r of near) nearBest = Math.max(nearBest, rowBest(r));
        derived.nearBestMbps = nearBest || null;

        const noNearby = pinged.length > 0 && pinged[0].pingMs >= 80;
        if (noNearby) {
            findings.push(f('net.no-nearby-server', 'info', 'No test server within 80 ms',
                'Every default server is intercontinental from here; the port verdict is weak. ' +
                'Re-run with `-p` against a nearby iperf3 server.', A_DIST));
        }
        const veryLow = peak > 0 && peak < 50 && (!pinged.length || !noNearby);
        if (veryLow) {
            findings.push(f('net.very-low-peak', 'warn',
                'Below any common port class everywhere',
                'Even nearby servers stay under 50 Mbit/s — a heavily shaped plan, ' +
                'a saturated uplink, or a congested NAT gateway.', A_CEIL));
        }

        if (nearBest > 0 && sold) {
            const ratio = nearBest / port;
            const pct = Math.round(ratio * 100);
            if (ratio >= 0.90) {
                if (!veryLow) {
                    findings.push(f('net.port-delivered', 'ok',
                        `Nearest server reaches ${pct}% of the port`,
                        'The port is delivered.', A_CEIL));
                }
            } else if (ratio >= 0.50) {
                findings.push(f('net.port-partial', noNearby ? 'info' : 'warn',
                    `Nearest server only reaches ${pct}% of the ${fmtPort(port)} port`,
                    'Shared/fair-use uplink or evening contention; re-run at another hour.', A_CEIL));
            } else {
                findings.push(f('net.port-shortfall', 'bad',
                    `Nearest server at ${pct}% of the ${fmtPort(port)} port`,
                    'Well below what was sold.', A_CEIL));
            }
        } else if (nearBest > 0 && peak > 0) {
            // unsold: judge the nearest servers against the best value observed anywhere
            const ratio = nearBest / peak;
            if (ratio >= 0.90) {
                if (!veryLow) {
                    findings.push(f('net.port-delivered', 'ok',
                        `Nearest server reaches ${fmtInt(nearBest)} Mbit/s — at least a ` +
                        `${fmtPort(inferred)} class port`,
                        'Sold port unknown, so this is judged against the best value observed; ' +
                        'pick the sold port above for a stricter check.', A_CEIL));
                }
            } else {
                findings.push(f('net.near-below-peak',
                    (ratio < 0.50 && !noNearby) ? 'warn' : 'info',
                    `Nearest server is slower than a farther one ` +
                    `(${fmtInt(nearBest)} vs ${fmtInt(peak)} Mbit/s)`,
                    'Near-end congestion at test time or a busy nearby remote; ' +
                    're-run at another hour.', A_CEIL));
            }
        }

        // direction asymmetry across rows with both directions
        const both = rows.filter(r => !r.sendBusy && !r.recvBusy
            && r.sendMbps != null && r.recvMbps != null);
        if (both.length >= 2) {
            const medSend = median(both.map(r => r.sendMbps));
            const medRecv = median(both.map(r => r.recvMbps));
            if (medRecv > 0 && medSend / medRecv < 0.33) {
                findings.push(f('net.upload-capped', 'warn',
                    'Send far lower than Recv everywhere',
                    'Provider-side upload cap or shaping; check the plan terms.', A_PAT));
            } else if (medSend > 0 && medRecv / medSend < 0.33) {
                findings.push(f('net.download-capped', 'warn',
                    'Recv far lower than Send everywhere',
                    'Inbound shaping, virtio/NIC offload issues, or inline DDoS mitigation.', A_PAT));
            }
        }

        // round-number cap on both directions
        const vals = [];
        for (const r of rows) {
            if (!r.sendBusy && r.sendMbps != null) vals.push({ v: r.sendMbps, dir: 'send' });
            if (!r.recvBusy && r.recvMbps != null) vals.push({ v: r.recvMbps, dir: 'recv' });
        }
        const STD_CEILS = [94, 950, 2400, 9500];
        for (const N of [50, 100, 200, 250, 300, 500, 1000]) {
            if (STD_CEILS.some(c => Math.abs(N - c) <= 0.06 * c)) continue;
            const hits = vals.filter(x => Math.abs(x.v - N) / N <= 0.05);
            if (hits.length >= 4 && new Set(hits.map(h => h.dir)).size >= 2) {
                findings.push(f('net.shaped', 'info',
                    `Both directions sit near ${N} Mbit/s`, 'Looks like a shaped port.', A_PAT));
                break;
            }
        }

        // distance-adjusted expectations
        const share = p => p < 20 ? 0.85 : p < 80 ? 0.50 : p < 150 ? 0.25 : 0.15;
        const below = [];
        for (const r of rows) {
            if (r.pingMs == null) continue;
            const best = rowBest(r);
            if (!(best > 0)) continue;
            const linkCap = r.linkGbps ? r.linkGbps * 1000 * 0.95 : Infinity;
            if (Math.min(best, linkCap) < share(r.pingMs) * Math.min(port, linkCap)) below.push(r);
        }
        const belowFar = below.filter(r => !nearSet.has(r));
        const belowNear = below.filter(r => nearSet.has(r));
        if (below.length === 1 && !nearSet.has(below[0])) {
            findings.push(f('net.one-location-slow', 'info',
                `${below[0].provider}, ${below[0].loc} is worse than its neighbours`,
                'Far-end congestion or peering to that network, not your server.', A_DIST));
        } else if (belowFar.length >= 2 && belowNear.length === 0) {
            findings.push(f('net.far-uniformly-low', 'warn',
                'Far-away servers are uniformly below the latency-adjusted expectation',
                'Provider transit/routing rather than the port.', A_DIST));
        }

        if (!pinged.length) {
            findings.push(f('net.ping-missing', 'info', 'No latency column',
                'No `ping` binary or ICMP filtered; distance-adjusted checks were skipped ' +
                'and the nearest server was guessed from throughput.',
                TN + '#where-the-latency-column-comes-from'));
        }

        // rows capped by the remote's advertised port, not ours
        const linkBound = rows.filter(r => r.linkGbps && rowBest(r) >= 0.90 * r.linkGbps * 1000);
        if (linkBound.length) {
            const nonBusy = rows.filter(r => !r.sendBusy || !r.recvBusy);
            let detail = 'Capped by the remote\'s advertised port: '
                + linkBound.map(r => r.loc).join('; ') + '. '
                + 'A "(1G)" remote can never show more than ~940 Mbit/s';
            if (nonBusy.length && nonBusy.every(r => linkBound.includes(r))) {
                detail += ' — your port may be faster than the inferred lower bound';
            }
            findings.push(f('net.remote-link-bound', 'info',
                'Limited by the remote\'s port, not yours', detail + '.', '#what-the-columns-mean'));
        }

        const DEFAULT_PROVIDERS = /Clouvider|Eranium|Uztelecom|Leaseweb|Edgoo|Hybula|Scaleway|WebHorizon|Bouygues|Online\.net|Severius|Worldstream|wilhelm|Biznet|Hostkey|Vultr|Velocity|Airstream|Hurricane|Telia/i;
        if (!rows.some(r => DEFAULT_PROVIDERS.test(r.provider))) {
            findings.push(f('net.custom-servers', 'info', 'Custom `-p` server list',
                'Link labels and locations are user-supplied; the default-list heuristics ' +
                'may not apply.', TN + '#the-server-list'));
        }

        // ipv6 vs ipv4 on the same servers
        if (v4.length && v6.length) {
            const slow = [];
            const faster = [];
            const faster2 = [];
            for (const r6 of v6) {
                const r4 = v4.find(r => r.provider === r6.provider && r.loc === r6.loc);
                if (!r4 || r4.sendBusy || r4.recvBusy || r6.sendBusy || r6.recvBusy) continue;
                const a4 = (r4.sendMbps + r4.recvMbps) / 2;
                const a6 = (r6.sendMbps + r6.recvMbps) / 2;
                if (a6 < 0.5 * a4) slow.push(r6.loc);
                if (a6 >= 1.5 * a4) faster.push(r4);
                if (a6 >= 2.0 * a4) faster2.push(r4);
            }
            if (slow.length) {
                findings.push(f('net.ipv6-slower', 'info',
                    'IPv6 much slower than IPv4 to the same server',
                    `At: ${slow.join(', ')}.`, A_PAT));
            }
            if (faster.length >= 3 && faster.some(r => nearSet.has(r))) {
                findings.push(f('net.ipv6-faster', 'warn',
                    'IPv6 noticeably faster than IPv4 to the same servers',
                    'The IPv4 path is the limited one — typical of a NAT/shared-IPv4 VPS ' +
                    '(results reflect the NAT gateway\'s capacity), IPv4-only shaping, or ' +
                    'inline DDoS scrubbing on v4. Your IPv6 numbers are the better read ' +
                    'of the raw port.', A_PAT));
            } else if (faster.length >= 2 || faster2.length >= 1) {
                findings.push(f('net.ipv6-faster', 'info',
                    'IPv6 noticeably faster than IPv4 to the same servers',
                    'The IPv4 path is the limited one — typical of a NAT/shared-IPv4 VPS ' +
                    '(results reflect the NAT gateway\'s capacity), IPv4-only shaping, or ' +
                    'inline DDoS scrubbing on v4. Your IPv6 numbers are the better read ' +
                    'of the raw port.', A_PAT));
            }
        }

        if (rows.length <= 3) {
            findings.push(f('net.reduced-run', 'info',
                `Only ${rows.length} locations (\`-r\` reduced run)`,
                'Less geographic coverage.', TN + '#the-server-list'));
        }

        return { headline: headline, findings: sortFindings(findings) };
    }

    // -----------------------------------------------------------------------
    // CPU
    // -----------------------------------------------------------------------

    const HIDDEN_MODEL = /QEMU Virtual CPU|Common KVM processor|Virtual CPU|^AMD EPYC Processor(\s*\(with IBPB\))?$|^Intel Xeon Processor \((Skylake|Cascadelake|Icelake|Sapphire ?Rapids)/i;

    const GB_BANDS = [
        [2600, 'ok', 'current high-clock desktop silicon (Ryzen 7000/9000, Core 13th/14th gen)'],
        [1800, 'ok', 'recent server parts at good clocks (EPYC Genoa/Turin, Sapphire/Emerald Rapids, Ryzen 5000)'],
        [1200, 'ok', 'EPYC Rome/Milan, Xeon Ice Lake/Cascade Lake — most premium KVM plans 2020–2024'],
        [800, 'ok', 'Xeon Scalable 1st/2nd gen, E5 v3/v4, Ampere Altra — mid-market VPS'],
        [500, 'info', 'older Xeon E5 v1/v2, low-clock many-core parts, or a busy shared node'],
        [0, 'warn', 'Atom/N-series, very old hardware, heavily oversold, or CPU-capped'],
    ];

    const GB_FAIL_CAUSES = [
        [/low memory was detected/i, 'low memory',
            'Geekbench 5/6/7 needs >1 GiB free; add swap or use `-4`.'],
        [/only be downloaded over IPv4/i, 'IPv4-only download',
            'cdn.geekbench.com is IPv4-only; no CPU result on IPv6-only hosts.'],
        [/requires tar/i, 'missing tar', '`tar` missing — install it and re-run.'],
        [/CentOS 7 and Geekbench/i, 'CentOS 7 glibc',
            'glibc 2.17 < 2.27 required by GB6/7; use `-4`/`-5`.'],
        [/cannot run on 32-bit/i, '32-bit x86', '32-bit x86 — only Geekbench 4 runs.'],
        [/Geekbench \d+ test failed/i, 'generic failure',
            'Generic failure — run geekbenchN by hand for the real error.'],
    ];

    function assessCpu(model, ctx, derived) {
        const findings = [];
        const s = model.sys || {};
        const gbs = model.geekbench || [];
        const vt = (s.vmType || '').toUpperCase();
        let headline = null;

        const numeric = gbs.filter(g => typeof g.single === 'number'
            && typeof g.multi === 'number' && g.single > 0);

        if (!numeric.length) {
            if (!gbs.length) {
                findings.push(f('cpu.skipped', 'info', 'No Geekbench result',
                    'The CPU test was skipped or failed.',
                    TC + '#failure-messages-and-what-they-mean'));
            }
            const cause = GB_FAIL_CAUSES.find(c =>
                (model.warnings || []).some(w => c[0].test(w)));
            if (cause) {
                findings.push(f('cpu.gb-failed', 'info',
                    `Geekbench failed: ${cause[1]}`, cause[2],
                    TC + '#failure-messages-and-what-they-mean'));
            } else if (s.ramGiB != null && s.ramGiB <= 1.0) {
                findings.push(f('cpu.memory-skip', 'info',
                    'Geekbench likely failed on memory',
                    'Geekbench 5/6/7 need ~1 GiB free; on ≤1 GiB plans it fails — ' +
                    'a memory story, not a CPU result.',
                    '#caveats-specific-to-yabss-cpu-reporting'));
            }
            const noScores = gbs.find(g => g.url && (g.single == null || g.multi == null));
            if (noScores) {
                findings.push(f('cpu.gb-no-scores', 'info',
                    'Geekbench uploaded but scores could not be parsed',
                    'Open the Full Test link; the page has the scores ' +
                    '(markup change or page not live yet).', TF + '#by-symptom'));
            }
            if (gbs.length >= 2) {
                findings.push(f('cpu.multiple-versions', 'info',
                    'Multiple Geekbench versions ran',
                    'Scores are on different scales — never compare across versions.',
                    '#the-scales-never-compare-across-versions'));
            }
            addCpuShared(findings, s, vt, gbs);
            return { headline: headline, findings: sortFindings(findings) };
        }

        const pool = numeric.length ? numeric : gbs;
        const primary = pool.reduce((a, b) => (b.version || 0) > (a.version || 0) ? b : a);
        const N = s.cores;

        derived.gbVersion = primary.version;
        derived.gbSingle = primary.single;
        derived.gbMulti = primary.multi;

        for (const g of numeric) {
            const r = g.multi / g.single;
            if (g === primary) derived.gbRatio = r;

            if (g.version >= 6) {
                const band = GB_BANDS.find(b => g.single >= b[0]);
                findings.push(f('cpu.single-band', band[1],
                    `Geekbench ${g.version} single-core ${fmtInt(g.single)}`,
                    band[2] + (g.version === 7
                        ? ' (GB7 uses the same 2,500 baseline; bands are approximate)' : '') + '.',
                    A_LAND));
            } else {
                findings.push(f('cpu.no-landmarks', 'info',
                    `Geekbench ${g.version}: ${fmtInt(g.single)} / ${fmtInt(g.multi)}`,
                    `No landmark table for Geekbench ${g.version}; compare only against ` +
                    'same-version results on the Geekbench Browser.',
                    '#the-scales-never-compare-across-versions'));
            }

            if (N == null) continue;
            const rn = r / N;
            const rr = Math.round(r * 100) / 100;
            if (N >= 2 && r <= 1.0) {
                findings.push(f('cpu.multi-le-single', 'bad',
                    'Multi-core no better than single-core',
                    `On ${N} vCPUs — hard CPU cap, severe steal, or a quota of roughly one core.`,
                    A_LAND));
            } else if (N >= 2 && rn < 0.5) {
                const lowSev = (N < 8 && (s.vmType || '').toUpperCase() !== 'NONE')
                    ? 'warn' : 'info';
                findings.push(f('cpu.low-scaling', lowSev,
                    `Multi ÷ single = ${rr} on ${N} vCPUs (<0.5×)`,
                    'Heavy contention, a cgroup CPU quota, or GB6/7\'s deliberately ' +
                    'sub-linear scaling on large N.', A_LAND));
            } else if (N >= 2 && rn < 0.9) {
                findings.push(f('cpu.smt-scaling', 'ok',
                    `Multi ÷ single = ${rr} on ${N} vCPUs`,
                    'SMT siblings and/or moderate contention; the norm for shared plans.', A_LAND));
            } else if (N >= 2 && rn <= 1.15) {
                findings.push(f('cpu.dedicated-scaling', 'ok',
                    `Multi ÷ single = ${rr} on ${N} vCPUs`,
                    'Each vCPU behaves like a lightly loaded, dedicated-ish core.', A_LAND));
            } else if (rn > 1.15) {
                findings.push(f('cpu.scaling-above-count', 'info',
                    'Multi exceeds single × vCPU count',
                    'Core count may be misreported or the single-core run was depressed.', A_LAND));
            }
        }

        headline = `Geekbench ${primary.version}: ${primary.single != null ? primary.single : '—'} ` +
            `single / ${primary.multi != null ? primary.multi : '—'} multi`;
        if (primary.single && primary.multi) {
            const r = primary.multi / primary.single;
            headline += `, ratio ${Math.round(r * 100) / 100}` + (N != null ? ` on ${N} vCPUs` : '');
        }

        if (N != null && N >= 8 && primary.version >= 6 && primary.single < 800) {
            findings.push(f('cpu.many-slow-cores', 'info',
                'Many vCPUs, weak per-core speed',
                'Good for parallel batch work; each web request, PHP page or SQL query ' +
                'will feel slow. Single-core is the "does it feel fast" number.',
                '#single-core-vs-multi-core'));
        }
        if (gbs.length >= 2) {
            findings.push(f('cpu.multiple-versions', 'info',
                'Multiple Geekbench versions ran',
                'Scores are on different scales — never compare across versions.',
                '#the-scales-never-compare-across-versions'));
        }

        const gbUrl = primary.url || (gbs.find(g => g.url) || {}).url;
        if (gbUrl) {
            findings.push(f('cpu.gb-url', 'info',
                'Compare on the Geekbench Browser against the same CPU model', gbUrl,
                '#comparing-against-other-peoples-results'));
        }

        addCpuShared(findings, s, vt, gbs);
        return { headline: headline, findings: sortFindings(findings) };
    }

    function addCpuShared(findings, s, vt, gbs) {
        if (s.cpuModel && HIDDEN_MODEL.test(s.cpuModel)) {
            findings.push(f('cpu.hidden-model', 'info',
                'Provider hides the real CPU model', 'Compare by score only.', A_SYS));
        }
        if (s.aes === false) {
            findings.push(f('cpu.aes-disabled', 'warn', 'AES-NI not exposed to the VM',
                'Slower TLS, VPN and disk encryption.', A_SYS));
        }
        if (s.virt === true && vt !== 'NONE') {
            findings.push(f('cpu.nested-virt', 'info', 'Nested virtualisation exposed',
                'VT-x/AMD-V is passed through — you can run VMs inside this VM.', A_SYS));
        } else if (s.virt === false && vt === 'NONE') {
            findings.push(f('cpu.no-virt-bare-metal', 'info',
                'Bare metal without VT-x/AMD-V',
                'Disabled in firmware, or an undetected hypervisor.', A_SYS));
        }
    }

    // -----------------------------------------------------------------------
    // Context
    // -----------------------------------------------------------------------

    function assessCtx(model, ctx, derived, cpuFindings) {
        const findings = [];
        const s = model.sys || {};
        const warnings = model.warnings || [];
        const match = re => warnings.some(w => re.test(w));

        findings.push(f('ctx.snapshot', 'info', 'One run is one sample',
            'Re-run at a different hour before drawing conclusions.',
            BS + '#why-one-run-proves-little'));

        if (model.runtimeSec != null) {
            const busyCells = derived.busyCells || 0;
            const expectedMax = 900
                + ((model.iperf && model.iperf.IPv6.length) ? 300 : 0)
                + 45 * busyCells;
            if (model.runtimeSec > expectedMax) {
                const cpuSlow = (derived.gbSingle != null && derived.gbSingle < 800)
                    || (cpuFindings || []).some(x =>
                        x.id === 'cpu.multi-le-single' || x.id === 'cpu.low-scaling');
                const detail = cpuSlow
                    ? 'Geekbench dominates runtime on slow or contended CPUs — ' +
                      'consistent with the CPU findings.'
                    : busyCells >= 4
                        ? `${busyCells} busy iperf results each cost up to ~45 s of retries.`
                        : 'Nothing in the tables explains it — suspect a slow Geekbench ' +
                          'download (100–200 MB tarball), a stalled disk test (35 s kill ' +
                          'per block size), or host contention during the run.';
                findings.push(f('ctx.long-runtime',
                    model.runtimeSec > 2 * expectedMax ? 'warn' : 'info',
                    `Run took ${Math.round(model.runtimeSec / 60)} min (typical 5–15)`,
                    detail, UO + '#footer'));
            }
        }
        if (match(/locale 'C' not detected/i)) {
            findings.push(f('ctx.locale-warning', 'warn',
                'C locale missing — numbers may be mis-parsed',
                'Decimal-comma systems can mangle fio/iperf parsing; ' +
                'double-check odd values.', TF + '#startup-and-environment'));
        }
        if (match(/Both IPv4 AND IPv6 connectivity/i)) {
            findings.push(f('ctx.no-connectivity', 'warn',
                'No internet connectivity detected at start',
                'Downloads and iperf will have failed; check DNS and egress firewall.',
                TF + '#startup-and-environment'));
        }

        if (s.uptimeSec != null && s.uptimeSec < 3600) {
            findings.push(f('ctx.fresh-vm', 'info',
                `Fresh VM (${Math.round(s.uptimeSec / 60)} min uptime)`,
                'First-boot tasks may depress numbers, and the host may still be empty.', A_SYS));
        }
        if (s.uptimeSec != null && s.uptimeSec > 180 * 86400) {
            findings.push(f('ctx.long-uptime', 'info',
                `Up for ${Math.round(s.uptimeSec / 86400)} days`,
                'A long-lived box has had time for storage to fill and for neighbours to ' +
                'arrive; also a long-unpatched kernel.', A_SYS));
        }
        const vt = (s.vmType || '').toUpperCase();
        if (vt === 'WSL') {
            findings.push(f('ctx.container', 'info', 'WSL',
                'Numbers reflect the Windows host\'s virtual disk and NAT network.', A_SYS));
        } else if (vt === 'LXC' || vt === 'OPENVZ' || vt === 'DOCKER') {
            findings.push(f('ctx.container', 'info', `Container (${vt})`,
                'CPU and memory limits are cgroup quotas; disk numbers describe the host\'s storage.',
                A_SYS));
        } else if (vt === 'NONE') {
            findings.push(f('ctx.bare-metal', 'info', 'Bare metal',
                'Or an undetectable hypervisor.', A_SYS));
        }
        if ((!s.vmType || vt === 'UNKNOWN') && s.cpuModel) {
            findings.push(f('ctx.vm-type-unknown', 'info',
                'VM type not detected (`systemd-detect-virt` absent)', '',
                TF + '#by-symptom'));
        }
        if (s.ipv4 === false) {
            findings.push(f('ctx.ipv4-offline', 'info', 'No IPv4',
                'Geekbench cannot be downloaded (IPv4-only CDN), no Network Information ' +
                'block, iperf runs IPv6 only.', A_SYS));
        }
        if (s.ipv6 === false) {
            findings.push(f('ctx.ipv6-offline', 'info', 'No IPv6',
                'No IPv6 iperf table; not a defect.', A_SYS));
        }
        if (s.swapGiB === 0 && s.ramGiB != null && s.ramGiB < 2) {
            findings.push(f('ctx.no-swap-small-ram', 'info', 'No swap on a small plan',
                'Geekbench may fail and fio needs memory for its queues.', A_SYS));
        }
        if (s.arch === 'riscv' || match(/RISC-V compatibility/i)) {
            findings.push(f('ctx.riscv-experimental', 'info',
                'RISC-V: experimental support; Geekbench builds are previews', '',
                TC + '#versions-downloads-and-platform-support'));
        }
        if (model.runHour != null && model.runHour >= 1 && model.runHour <= 6) {
            findings.push(f('ctx.quiet-hours', 'info',
                `Run at ${String(model.runHour).padStart(2, '0')}:00 local — quiet hours`,
                'Shared hosts are least loaded at night; results may be flattering. ' +
                'Re-run around 20:00–22:00 for the other bound.',
                BS + '#1-run-more-than-once-at-different-times'));
        } else if (model.runHour != null && model.runHour >= 18 && model.runHour <= 23) {
            findings.push(f('ctx.peak-hours', 'info',
                `Run at ${String(model.runHour).padStart(2, '0')}:00 local — peak hours`,
                'Likely the conservative bound; a night run shows the ceiling.',
                BS + '#1-run-more-than-once-at-different-times'));
        }
        if (model.runDate) {
            const now = ctx && ctx.now ? new Date(ctx.now) : new Date();
            const then = new Date(model.runDate + 'T00:00:00');
            const days = (now - then) / 86400000;
            if (isFinite(days) && days > 365) {
                findings.push(f('ctx.stale-result', 'info',
                    `Result is ${Math.max(1, Math.floor(days / 365))} year(s) old`,
                    'Hardware, Geekbench versions and the iperf server list have changed ' +
                    'since; compare only with results from the same era.',
                    BS + '#reading-other-peoples-snapshots'));
            }
        }
        if (model.version && model.version < 'v2026-07-01') {
            findings.push(f('ctx.old-version', 'info', 'Result from before July 2026',
                'fio was displayed ~2.4% low (KiB labelled KB).', TD + '#units-and-the-kibkb-story'));
        }
        if (model.ipinfo) {
            findings.push(f('ctx.ipinfo-ignored', 'info',
                'ISP/location block parsed but ignored', 'Nothing leaves your browser.',
                UO + '#network-information'));
        }

        const parts = [
            s.cpuModel,
            s.cores != null ? `${s.cores} vCPU` : null,
            s.ramGiB != null ? `${Math.round(s.ramGiB * 10) / 10} GiB RAM` : null,
            s.vmType,
            s.distro,
        ].filter(Boolean);
        derived.contextLine = parts.join(', ') || null;

        return { headline: parts.join(', ') || null, findings: sortFindings(findings) };
    }

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------

    function assess(model, ctx) {
        ctx = ctx || {};
        const derived = {};
        const disk = assessDisk(model, ctx, derived);
        const network = assessNet(model, ctx, derived);
        const cpu = assessCpu(model, ctx, derived);
        const context = assessCtx(model, ctx, derived, cpu.findings);

        const hasDisk = model.disk && (model.disk.kind === 'dd'
            || (model.disk.kind === 'fio' && Object.keys(model.disk.rows || {}).length));
        const hasNet = ((model.iperf && model.iperf.IPv4.length) || 0)
            + ((model.iperf && model.iperf.IPv6.length) || 0) > 0;
        const hasCpu = (model.geekbench || []).length > 0;

        let overall;
        if (!hasDisk && !hasNet && !hasCpu) {
            overall = 'incomplete';
        } else {
            const sev = {};
            for (const area of [disk, network, cpu, context]) {
                for (const x of area.findings) sev[x.severity] = (sev[x.severity] || 0) + 1;
            }
            derived.severityCounts = sev;
            overall = sev.bad ? 'concerning' : sev.warn ? 'mixed' : 'healthy';
        }

        return {
            overall: overall,
            areas: { disk: disk, network: network, cpu: cpu, context: context },
            derived: derived,
        };
    }

    return { assess: assess, WIKI_BASE: WIKI_BASE };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = YabsRules;
