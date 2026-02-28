/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ["class"],
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive) / <alpha-value>)",
          foreground: "hsl(var(--destructive-foreground) / <alpha-value>)",
        },
        warning: {
          DEFAULT: "hsl(var(--warning) / <alpha-value>)",
          foreground: "hsl(var(--warning-foreground) / <alpha-value>)",
        },
        info: {
          DEFAULT: "hsl(var(--info) / <alpha-value>)",
          foreground: "hsl(var(--info-foreground) / <alpha-value>)",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        "primary-blue": "#0066FF",
        "primary-dark": "#0A1628",
        "primary-light": "#E8F1FF",
        "accent-blue": "#00A3FF",
        "danger-red": "#DC2626",
        "warning-amber": "#F59E0B",
        "success-green": "#10B981",
        "text-primary": "#1A1A2E",
        "text-secondary": "#64748B",
        "text-muted": "#94A3B8",
        "bg-light": "#F8FAFC",
        "border-light": "#E2E8F0",
      },
      borderRadius: {
        xl: "calc(var(--radius) + 4px)",
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
        xs: "calc(var(--radius) - 6px)",
      },
      boxShadow: {
        xs: "0 1px 2px 0 rgb(0 0 0 / 0.05)",
        glow: "0 0 20px rgba(0, 102, 255, 0.25)",
        "glow-strong": "0 0 30px rgba(0, 102, 255, 0.4)",
        "glow-amber": "0 0 20px rgba(245, 158, 11, 0.3)",
        "glow-red": "0 0 20px rgba(220, 38, 38, 0.3)",
        card: "0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)",
        "card-hover": "0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)",
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'monospace'],
      },
      fontSize: {
        'micro': ['10px', { lineHeight: '1.4', letterSpacing: '0.05em' }],
        'label': ['12px', { lineHeight: '1.4', letterSpacing: '0.03em' }],
        'button': ['14px', { lineHeight: '1.4', letterSpacing: '0.02em' }],
        'body': ['16px', { lineHeight: '1.5', letterSpacing: '0' }],
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        "caret-blink": {
          "0%,70%,100%": { opacity: "1" },
          "20%,50%": { opacity: "0" },
        },
        "fadeUp": {
          from: { opacity: "0", transform: "translateY(8px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "modalIn": {
          from: { opacity: "0", transform: "scale(0.98)" },
          to: { opacity: "1", transform: "scale(1)" },
        },
        "pulse-glow": {
          "0%, 100%": { opacity: "1", boxShadow: "0 0 8px rgba(0, 102, 255, 0.4)" },
          "50%": { opacity: "0.8", boxShadow: "0 0 16px rgba(0, 102, 255, 0.6)" },
        },
        "scanline": {
          "0%": { transform: "translateY(0)" },
          "50%": { transform: "translateY(280px)" },
          "100%": { transform: "translateY(0)" },
        },
        "shimmer": {
          "0%": { opacity: "0.3" },
          "50%": { opacity: "0.7" },
          "100%": { opacity: "0.3" },
        },
        "spin-slow": {
          from: { transform: "rotate(0deg)" },
          to: { transform: "rotate(360deg)" },
        },
        "spin-reverse": {
          from: { transform: "rotate(360deg)" },
          to: { transform: "rotate(0deg)" },
        },
        "scanbar": {
          "0%": { transform: "translateX(-100%)" },
          "100%": { transform: "translateX(100%)" },
        },
        "pulse-dot": {
          "0%, 100%": { opacity: "1", transform: "scale(1)" },
          "50%": { opacity: "0.5", transform: "scale(1.1)" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "caret-blink": "caret-blink 1.25s ease-out infinite",
        "fadeUp": "fadeUp 300ms ease forwards",
        "modalIn": "modalIn 220ms ease forwards",
        "pulse-glow": "pulse-glow 1.2s ease-in-out infinite",
        "scanline": "scanline 1.5s ease-in-out infinite",
        "shimmer": "shimmer 1.4s ease infinite",
        "spin-slow": "spin-slow 0.7s linear infinite",
        "spin-reverse": "spin-reverse 1.2s linear infinite",
        "scanbar": "scanbar 2s linear infinite",
        "pulse-dot": "pulse-dot 1s ease-in-out infinite",
      },
      maxWidth: {
        'app': '520px',
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
}
