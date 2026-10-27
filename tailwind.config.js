/** @type {import('tailwindcss').Config} */
// VulNexis premium design tokens — warm near-black, hairline borders,
// Inter UI + IBM Plex Mono terminal, soft radii, restrained accents.
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        bg: {
          primary: '#12100f',
          secondary: '#181614',
          tertiary: '#201d1a',
          elevated: '#262220',
        },
        border: '#34302c',
        bordermuted: '#262220',
        text: {
          primary: '#f0eeea',
          secondary: '#bcb8b1',
          muted: '#8a8580',
          disabled: '#5c5854',
        },
        accent: {
          cyan: '#56b4ff',
          green: '#46c285',
          amber: '#e8a33d',
          red: '#e5655e',
          purple: '#a78bfa',
        }
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      borderRadius: {
        none: '0',
        sm: '4px',
        DEFAULT: '8px',
        md: '10px',
        lg: '12px',
        xl: '16px',
        '2xl': '20px',
      },
      boxShadow: {
        card: '0 1px 2px rgba(0,0,0,0.25), 0 8px 24px rgba(0,0,0,0.18)',
        pop: '0 4px 12px rgba(0,0,0,0.35), 0 24px 64px rgba(0,0,0,0.35)',
        glow: '0 0 0 1px rgba(86,180,255,0.25), 0 0 24px rgba(86,180,255,0.12)',
      },
      letterSpacing: {
        micro: '0.09em',
      },
    },
  },
  plugins: [],
}
