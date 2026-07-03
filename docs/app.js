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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmt(n) {
    if (n === null || n === undefined) return '—';
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K';
    return n.toLocaleString();
}

async function fetchJSON(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} (${url})`);
    return res.json();
}

// ---------------------------------------------------------------------------
// Summary cards
// ---------------------------------------------------------------------------

async function loadSummary() {
    const d = await fetchJSON('/api/stats/summary');

    document.getElementById('stat-alltime').textContent = fmt(d.total_requests);
    document.getElementById('stat-30d').textContent     = fmt(d.last_30d_requests);
    document.getElementById('stat-7d').textContent      = fmt(d.last_7d_requests);
    document.getElementById('stat-today').textContent   = fmt(d.today_requests);

    if (d.data_since) {
        document.getElementById('stat-since').textContent = `Since ${d.data_since}`;
    }

    if (d.last_updated) {
        const dt = new Date(d.last_updated);
        document.getElementById('last-updated').textContent =
            'Data as of ' + dt.toUTCString();
    }
}

// ---------------------------------------------------------------------------
// Daily trend line chart
// ---------------------------------------------------------------------------

let dailyChart = null;

async function loadDailyChart(days) {
    const data = await fetchJSON(`/api/stats/daily?days=${days}`);

    if (dailyChart) { dailyChart.destroy(); dailyChart = null; }

    // For 'All', use month-level x-axis ticks; otherwise scale by range
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
                    callbacks: {
                        label: ctx => {
                            const ds = ctx.dataset.label;
                            return ds === 'Unique IPs'
                                ? ` ${ctx.parsed.y.toLocaleString()} unique IPs`
                                : ` ${ctx.parsed.y.toLocaleString()} runs`;
                        },
                    },
                },
            },
            scales: {
                x: {
                    type: 'time',
                    time: {
                        unit: days <= 30 ? 'day' : days <= 90 ? 'week' : 'month',
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
    const data = await fetchJSON(`/api/stats/countries?days=${days}`);
    const top  = data.slice(0, 15);

    if (countriesChart) { countriesChart.destroy(); countriesChart = null; }

    document.getElementById('countries-meta').textContent =
        days === 0 ? 'All time' : `Last ${days} days`;

    const ctx = document.getElementById('chart-countries').getContext('2d');
    countriesChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: top.map(d => d.country_code),
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
// Unique IPs / Day line chart  (replaces the Run Method doughnut)
// ---------------------------------------------------------------------------

let uaChart = null;

async function loadUAChart(days) {
    const data = await fetchJSON(`/api/stats/daily?days=${days}`);

    if (uaChart) { uaChart.destroy(); uaChart = null; }

    document.getElementById('ua-meta').textContent =
        (days === 0 ? 'All time' : `Last ${days} days`) + ' \u00b7 distinct servers';

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
                    callbacks: {
                        label: ctx => ` ${ctx.parsed.y.toLocaleString()} unique IPs`,
                    },
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
    // Cap at 365; 'All' falls back to 365 since the dist is based on stats_hour which
    // doesn't accumulate indefinitely in the same way as stats_day.
    const effectiveDays = days === 0 ? 365 : Math.min(days, 365);
    const resp = await fetchJSON(`/api/stats/hourly-distribution?days=${effectiveDays}`);
    const points = resp.data;

    // Build an honest subtitle: show the actual date range of hourly data used
    let subtitle;
    if (resp.hours_of_data === 0) {
        subtitle = 'No hourly data yet';
    } else if (resp.data_from && resp.data_to) {
        const from = resp.data_from.slice(0, 10);
        const to   = resp.data_to.slice(0, 10);
        subtitle = `Based on ${resp.hours_of_data} hrs of data (${from} \u2013 ${to})`;
    } else {
        subtitle = `Last ${effectiveDays} days \u00b7 when is YABS most commonly run?`;
    }
    document.getElementById('hour-dist-meta').textContent = subtitle;

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
                    return points.map(d => d.requests === max ? C.green : C.accent);
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
// Range button wiring — updates all four range-sensitive charts
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
