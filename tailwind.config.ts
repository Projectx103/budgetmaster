import type { Config } from 'tailwindcss';

/**
 * Tailwind configuration.
 * Every value here traces exactly to 20 - Design Tokens.md — no approximated or
 * invented values (per that document's §15 acceptance criteria). Dark mode uses
 * the 'class' strategy, toggled by ThemeContext (10 - Folder Structure.md §7).
 */
const config: Config = {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    // 20 - Design Tokens.md §10 — exact breakpoint cutoffs replace Tailwind's defaults.
    screens: {
      tablet: '640px',
      desktop: '1024px',
      wide: '1440px',
    },
    extend: {
      colors: {
        // §1 Light mode / §2 Dark mode — dark values applied via `dark:` variants
        // at the component level, since Tailwind color keys can't branch on mode directly.
        ink: {
          DEFAULT: '#1A1A1A',
          muted: '#5C5C5C',
          dark: '#1C1A18',
        },
        paper: {
          DEFAULT: '#FAF9F6',
          dark: '#F2EFEA',
          'dark-muted': '#B8B3AC',
        },
        stone: {
          DEFAULT: '#E8E5DF',
          dark: '#3A3733',
        },
        clay: {
          DEFAULT: '#B08968',
          text: '#8C6A4E',
          dark: '#C9A07E',
          'dark-text': '#D9B896',
        },
        moss: {
          DEFAULT: '#4A5D4E',
          dark: '#7FA087',
        },
        error: {
          DEFAULT: '#A33B2E',
          dark: '#D97C6C',
        },
        overlay: {
          DEFAULT: 'rgba(26, 26, 26, 0.5)',
          dark: 'rgba(0, 0, 0, 0.6)',
        },
      },
      fontFamily: {
        // §4 — Display: Fraunces (serif). Body: Inter (sans). Self-hosted per
        // 10 - Folder Structure.md §11; font files land in src/assets/fonts.
        display: ['Fraunces', 'serif'],
        body: ['Inter', 'sans-serif'],
      },
      fontSize: {
        // §4 — [size, { lineHeight, letterSpacing, fontWeight }] tuple form.
        'display-lg': ['3.5rem', { lineHeight: '1.1', letterSpacing: '-0.01em', fontWeight: '500' }],
        'display-md': ['2.5rem', { lineHeight: '1.15', letterSpacing: '-0.01em', fontWeight: '500' }],
        heading: ['1.75rem', { lineHeight: '1.25', letterSpacing: 'normal', fontWeight: '500' }],
        'body-lg': ['1.125rem', { lineHeight: '1.6', letterSpacing: 'normal', fontWeight: '400' }],
        'body-md': ['1rem', { lineHeight: '1.6', letterSpacing: 'normal', fontWeight: '400' }],
        'body-sm': ['0.875rem', { lineHeight: '1.5', letterSpacing: 'normal', fontWeight: '400' }],
        label: ['0.75rem', { lineHeight: '1.4', letterSpacing: '0.08em', fontWeight: '500' }],
      },
      spacing: {
        // §5 — 8-point base scale plus the sub-atomic 4px step; semantic aliases
        // (xs/sm/md/lg/xl/xxl) map onto it exactly as documented.
        px1: '0.25rem',
        xs: '0.5rem',
        sm: '1rem',
        md: '1.5rem',
        lg: '2.5rem',
        xl: '4rem',
        xxl: '6rem',
      },
      borderRadius: {
        // §6 — exactly two radius values in active use; `full` retained only for
        // the rare, currently-unused circular-element case.
        tight: '4px',
        DEFAULT: '8px',
      },
      boxShadow: {
        // §7 — single elevation style per surface type; never combined with a border.
        card: '0 1px 2px rgba(26,26,26,0.06), 0 2px 8px rgba(26,26,26,0.04)',
        'card-dark': '0 1px 2px rgba(0,0,0,0.24), 0 2px 8px rgba(0,0,0,0.16)',
        modal: '0 8px 24px rgba(26,26,26,0.12)',
        'modal-dark': '0 8px 24px rgba(0,0,0,0.36)',
        dropdown: '0 4px 12px rgba(26,26,26,0.10)',
        'dropdown-dark': '0 4px 12px rgba(0,0,0,0.30)',
      },
      opacity: {
        // §8.1 — no `blur` key exists anywhere in this config; the exclusion is
        // deliberate per §8.2, not an oversight.
        disabled: '0.4',
        hover: '0.85',
      },
      maxWidth: {
        // §9.1 — named container widths for narrower content contexts.
        'container-full': '1440px',
        'container-narrow': '720px',
        'container-form': '480px',
      },
      transitionDuration: {
        // §11 — short, gentle, never bouncy; no spring/elastic easing exists anywhere.
        fast: '120ms',
        DEFAULT: '200ms',
        slow: '320ms',
      },
      transitionTimingFunction: {
        standard: 'cubic-bezier(0.4, 0, 0.2, 1)',
        entrance: 'cubic-bezier(0, 0, 0.2, 1)',
        exit: 'cubic-bezier(0.4, 0, 1, 1)',
      },
      zIndex: {
        // §12 — the only z-index scale in the codebase; no raw numbers outside it.
        base: '0',
        dropdown: '10',
        stickyNav: '20',
        modalScrim: '30',
        modal: '40',
        toast: '50',
      },
    },
  },
  plugins: [],
};

export default config;
