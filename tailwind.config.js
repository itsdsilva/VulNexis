/** @type {import('tailwindcss').Config} */
// VulNexis design tokens — Notion-style neutral dark surfaces, hairline
// borders, hover-revealed controls, Inter UI + IBM Plex Mono terminal.
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        bg: {
          primary: '#191919',
          secondary: '#1e1e1e',
          tertiary: '#252525',
          elevated: '#2a2a2a',
        },
        border: '#383838',
        bordermuted: '#2d2d2d',
        text: {
          primary: '#e8e8e6',
          secondary: '#a6a6a3',
          muted: '#7d7d7a',
          disabled: '#575754',
        },
        accent: {
          cyan: '#4d9ff2',
          green: '#53b483',
          amber: '#d9a542',
          red: '#e26f65',
          purple: '#a78bfa',
          orange: '#f28b30',
        }
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      borderRadius: {
        none: '0',
        sm: '3px',
        DEFAULT: '6px',
        md: '8px',
        lg: '10px',
        xl: '12px',
        '2xl': '16px',
      },
      boxShadow: {
        card: '0 1px 2px rgba(0,0,0,0.30)',
        pop: '0 4px 12px rgba(0,0,0,0.35), 0 20px 48px rgba(0,0,0,0.45)',
        glow: '0 0 0 1px rgba(242,139,48,0.50), 0 0 0 3px rgba(242,139,48,0.12)',
      },
      letterSpacing: {
        micro: '0.08em',
      },
    },
  },
  plugins: [],
}
