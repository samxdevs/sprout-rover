// ============================================
// WEATHER
// ============================================
// Open-Meteo: free, no API key, no account, no attribution requirement.
// Queried for the rover's current position so conditions match the field
// being worked rather than a fixed location.
// ============================================

export interface Weather {
    temperatureC: number;
    windKph: number;
    humidityPct: number;
    /** WMO weather code — see codeToDescription. */
    code: number;
    description: string;
    /** Material Symbols icon name. */
    icon: string;
    isDay: boolean;
}

const ENDPOINT = 'https://api.open-meteo.com/v1/forecast';

/**
 * WMO 4677 weather codes, grouped into the bands that matter for spraying:
 * precipitation and wind are what stop field work.
 */
function describeCode(code: number, isDay: boolean): { description: string; icon: string } {
    const clearIcon = isDay ? 'clear_day' : 'clear_night';
    const cloudIcon = isDay ? 'partly_cloudy_day' : 'partly_cloudy_night';

    if (code === 0) return { description: 'Clear', icon: clearIcon };
    if (code <= 2) return { description: 'Partly Cloudy', icon: cloudIcon };
    if (code === 3) return { description: 'Overcast', icon: 'cloud' };
    if (code <= 48) return { description: 'Fog', icon: 'foggy' };
    if (code <= 57) return { description: 'Drizzle', icon: 'rainy' };
    if (code <= 67) return { description: 'Rain', icon: 'rainy' };
    if (code <= 77) return { description: 'Snow', icon: 'weather_snowy' };
    if (code <= 82) return { description: 'Rain Showers', icon: 'rainy' };
    if (code <= 86) return { description: 'Snow Showers', icon: 'weather_snowy' };
    if (code <= 99) return { description: 'Thunderstorm', icon: 'thunderstorm' };
    return { description: 'Unknown', icon: cloudIcon };
}

/**
 * Fetches current conditions for a coordinate.
 * Throws on network failure or a non-OK response so the caller can show a
 * clear "unavailable" state rather than stale or invented numbers.
 */
export async function fetchWeather(lat: number, lon: number): Promise<Weather> {
    const url =
        `${ENDPOINT}?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}` +
        `&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code,is_day` +
        `&wind_speed_unit=kmh&timezone=auto`;

    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`Weather service returned ${res.status}`);

    const data = await res.json();
    const c = data?.current;
    if (!c) throw new Error('Weather service returned no current conditions');

    const isDay = c.is_day === 1;
    const code = Number(c.weather_code ?? 0);
    const { description, icon } = describeCode(code, isDay);

    return {
        temperatureC: Number(c.temperature_2m),
        windKph: Number(c.wind_speed_10m),
        humidityPct: Number(c.relative_humidity_2m),
        code,
        description,
        icon,
        isDay,
    };
}

/**
 * Whether conditions are suitable for spraying.
 * Wind above ~15 km/h causes drift; rain washes product off before uptake.
 */
export function sprayAdvice(w: Weather): { ok: boolean; reason: string } {
    const raining = (w.code >= 51 && w.code <= 67) || (w.code >= 80 && w.code <= 99);
    if (raining) return { ok: false, reason: 'Rain — product will wash off' };
    if (w.windKph > 15) return { ok: false, reason: `Wind ${Math.round(w.windKph)} km/h — drift risk` };
    if (w.temperatureC > 35) return { ok: false, reason: 'Too hot — rapid evaporation' };
    return { ok: true, reason: 'Conditions suitable for spraying' };
}
