'use strict';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const C = {
    accent:     '#58a6ff',
    accentFill: 'rgba(88,166,255,0.10)',
    green:      '#3fb950',
    muted:      '#7d8590',
    border:     '#21262d',
    text:       '#e6edf3',
    palette: [
        '#58a6ff', '#3fb950', '#f0883e', '#bc8cff',
        '#ff7b72', '#79c0ff', '#56d364', '#ffa657',
    ],
};

Chart.defaults.color = C.muted;
Chart.defaults.font.family = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
Chart.defaults.font.size = 12;

const TOOLTIP_STYLE = {
    backgroundColor: '#1c2230',
    borderColor: '#30363d',
    borderWidth: 1,
};

const STATS = fetchJSON('data/stats.json');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmt(n) {
    if (n === null || n === undefined) return '-';
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K';
    return n.toLocaleString();
}

async function fetchJSON(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} (${url})`);
    return res.json();
}

function latestDate(rows, field) {
    if (!rows.length) return null;
    return rows[rows.length - 1][field].slice(0, 10);
}

function filterDaily(history, days) {
    if (!days) return history;
    if (!history.length) return [];

    const end = new Date(`${latestDate(history, 'date')}T00:00:00Z`);
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - days + 1);

    return history.filter(row => new Date(`${row.date}T00:00:00Z`) >= start);
}

function filterHourly(hourly, days) {
    if (!days) return hourly;
    if (!hourly.length) return [];

    const end = new Date(hourly[hourly.length - 1].datetime);
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - days);

    return hourly.filter(row => new Date(row.datetime) >= start);
}

function hourlyDistribution(hourly) {
    const totals = Array.from({ length: 24 }, (_, hour) => ({ hour, requests: 0 }));

    hourly.forEach(row => {
        const hour = new Date(row.datetime).getUTCHours();
        totals[hour].requests += row.requests || 0;
    });

    return totals;
}

// ---------------------------------------------------------------------------
// Summary cards
// ---------------------------------------------------------------------------

async function loadSummary() {
    const d = (await STATS).summary;

    document.getElementById('stat-alltime').textContent = fmt(d.all_time);
    document.getElementById('stat-30d').textContent     = fmt(d.last30);
    document.getElementById('stat-7d').textContent      = fmt(d.last7);
    document.getElementById('stat-today').textContent   = fmt(d.today);

    if (d.since) {
        document.getElementById('stat-since').textContent = `Since ${d.since}`;
    }

    if (d.updated) {
        const dt = new Date(d.updated);
        document.getElementById('last-updated').textContent =
            'Data as of ' + dt.toUTCString();
    }
}

// ---------------------------------------------------------------------------
// Daily trend line chart
// ---------------------------------------------------------------------------

let dailyChart = null;

async function loadDailyChart(days) {
    const data = filterDaily((await STATS).history, days);

    if (dailyChart) { dailyChart.destroy(); dailyChart = null; }

    const xUnit = days === 0 || days > 365 ? 'month' : days <= 30 ? 'day' : days <= 90 ? 'week' : 'month';
    const dotRadius = (days > 0 && days <= 30) ? 3 : 0;

    const ctx = document.getElementById('chart-daily').getContext('2d');
    dailyChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: data.map(d => d.date),
            datasets: [{
                label: 'Runs',
                data: data.map(d => d.requests),
                borderColor: C.accent,
                backgroundColor: C.accentFill,
                borderWidth: 2,
                pointRadius: dotRadius,
                pointHoverRadius: 5,
                pointBackgroundColor: C.accent,
                fill: true,
                tension: 0.3,
            }],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { display: false },
                tooltip: {
                    ...TOOLTIP_STYLE,
                    callbacks: { label: ctx => ` ${ctx.parsed.y.toLocaleString()} runs` },
                },
            },
            scales: {
                x: {
                    type: 'time',
                    time: {
                        unit: xUnit,
                        displayFormats: { day: 'MMM d', week: 'MMM d', month: 'MMM yyyy' },
                    },
                    grid: { color: C.border },
                    ticks: { maxTicksLimit: 10 },
                },
                y: {
                    beginAtZero: true,
                    grid: { color: C.border },
                    ticks: { callback: v => fmt(v) },
                },
            },
        },
    });
}

// ---------------------------------------------------------------------------
// Country bar chart
// ---------------------------------------------------------------------------

let countriesChart = null;

async function loadCountriesChart(days) {
    const top = (await STATS).countries.slice(0, 15);

    if (countriesChart) { countriesChart.destroy(); countriesChart = null; }

    document.getElementById('countries-meta').textContent =
        days === 0 ? 'Recent usage' : `Recent usage`;

    const ctx = document.getElementById('chart-countries').getContext('2d');
    countriesChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: top.map(d => d.country_code || d.country),
            datasets: [{
                label: 'Runs',
                data: top.map(d => d.requests),
                backgroundColor: C.accent,
                borderRadius: 3,
                borderSkipped: false,
            }],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            indexAxis: 'y',
            plugins: {
                legend: { display: false },
                tooltip: {
                    ...TOOLTIP_STYLE,
                    callbacks: { label: ctx => ` ${ctx.parsed.x.toLocaleString()} runs` },
                },
            },
            scales: {
                x: { grid: { color: C.border }, ticks: { callback: v => fmt(v) } },
                y: {
                    grid: { display: false },
                    ticks: { font: { family: 'monospace', size: 11 }, color: C.text },
                },
            },
        },
    });
}

// ---------------------------------------------------------------------------
// Unique IPs / Day line chart
// ---------------------------------------------------------------------------

let uaChart = null;

async function loadUAChart(days) {
    const data = filterDaily((await STATS).history, days);

    if (uaChart) { uaChart.destroy(); uaChart = null; }

    document.getElementById('ua-meta').textContent =
        (days === 0 ? 'All time' : `Last ${days} days`) + ' - distinct servers';

    const dotRadius = (days > 0 && days <= 30) ? 3 : 0;
    const xUnit = days === 0 || days > 365 ? 'month' : days <= 30 ? 'day' : days <= 90 ? 'week' : 'month';

    const ctx = document.getElementById('chart-ua').getContext('2d');
    uaChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: data.map(d => d.date),
            datasets: [{
                label: 'Unique IPs',
                data: data.map(d => d.unique_ips),
                borderColor: C.green,
                backgroundColor: 'rgba(63,185,80,0.10)',
                borderWidth: 2,
                pointRadius: dotRadius,
                pointHoverRadius: 5,
                pointBackgroundColor: C.green,
                fill: true,
                tension: 0.3,
            }],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { display: false },
                tooltip: {
                    ...TOOLTIP_STYLE,
                    callbacks: { label: ctx => ` ${ctx.parsed.y.toLocaleString()} unique IPs` },
                },
            },
            scales: {
                x: {
                    type: 'time',
                    time: {
                        unit: xUnit,
                        displayFormats: { day: 'MMM d', week: 'MMM d', month: 'MMM yyyy' },
                    },
                    grid: { color: C.border },
                    ticks: { maxTicksLimit: 10 },
                },
                y: {
                    beginAtZero: true,
                    grid: { color: C.border },
                    ticks: { callback: v => fmt(v) },
                },
            },
        },
    });
}

// ---------------------------------------------------------------------------
// Hourly distribution bar chart
// ---------------------------------------------------------------------------

let hourDistChart = null;

async function loadHourDistChart(days = 30) {
    const hourly = filterHourly((await STATS).hourly, days || 365);
    const points = hourlyDistribution(hourly);

    if (!hourly.length) {
        document.getElementById('hour-dist-meta').textContent = 'No hourly data yet';
    } else {
        const from = hourly[0].datetime.slice(0, 10);
        const to = hourly[hourly.length - 1].datetime.slice(0, 10);
        document.getElementById('hour-dist-meta').textContent =
            `Based on ${hourly.length} hrs of data (${from} - ${to})`;
    }

    if (hourDistChart) { hourDistChart.destroy(); hourDistChart = null; }

    const ctx = document.getElementById('chart-hour-dist').getContext('2d');
    hourDistChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: points.map(d => `${String(d.hour).padStart(2, '0')}:00`),
            datasets: [{
                label: 'Runs',
                data: points.map(d => d.requests),
                backgroundColor: (() => {
                    const max = Math.max(...points.map(x => x.requests));
                    return points.map(d => d.requests === max && max > 0 ? C.green : C.accent);
                })(),
                borderRadius: 3,
                borderSkipped: false,
            }],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    ...TOOLTIP_STYLE,
                    callbacks: { label: ctx => ` ${ctx.parsed.y.toLocaleString()} runs` },
                },
            },
            scales: {
                x: {
                    grid: { display: false },
                    ticks: {
                        maxRotation: 0,
                        callback: (_, i) => (i % 3 === 0)
                            ? `${String(i).padStart(2, '0')}:00`
                            : '',
                    },
                },
                y: {
                    beginAtZero: true,
                    grid: { color: C.border },
                    ticks: { callback: v => fmt(v) },
                },
            },
        },
    });
}

// ---------------------------------------------------------------------------
// Range button wiring
// ---------------------------------------------------------------------------

document.querySelectorAll('.range-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.range-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const days = parseInt(btn.dataset.days, 10);
        loadDailyChart(days).catch(console.error);
        loadCountriesChart(days).catch(console.error);
        loadUAChart(days).catch(console.error);
        loadHourDistChart(days).catch(console.error);
    });
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

(async function init() {
    await Promise.allSettled([
        loadSummary(),
        loadDailyChart(30),
        loadCountriesChart(30),
        loadUAChart(30),
        loadHourDistChart(),
    ]);
})();
