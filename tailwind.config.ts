import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/app/**/*.{ts,tsx}", "./src/lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Tabletop/card-frame design tokens (issue #64) — shared so later
        // passes (Stats, Settings, roll/reveal) restyle from the same
        // palette instead of scattering hex values through components.
        tavern: {
          plank: "#4a3222",
          "plank-dark": "#3a2718",
          panel: "#2a1e14",
          "panel-dark": "#1c130c",
        },
        gilt: {
          DEFAULT: "#c9a54a",
          bright: "#e8ce8f",
          dark: "#8a6a2c",
        },
        parchment: {
          DEFAULT: "#f1e6cf",
          dim: "#c9bda3",
        },
        ember: {
          DEFAULT: "#7a3b2e",
          bright: "#b3543f",
        },
      },
      fontFamily: {
        display: ["var(--font-display)", "serif"],
        body: ["var(--font-body)", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      keyframes: {
        // Teaspoon-in-cup pending indicator (issue #171) — a stir motion
        // (rock back and forth around the rim) reads more thematic at small
        // size than a full 360° spin.
        "teaspoon-stir": {
          "0%, 100%": { transform: "rotate(-20deg)" },
          "50%": { transform: "rotate(20deg)" },
        },
        // Landed 3D reveal die (issue #602) — a short drop-and-settle onto
        // the row (tilted in the air, overshoots the rest pose, stops well
        // under two seconds). Skipped entirely under reduced motion via
        // motion-reduce:animate-none and the hook's static entrance.
        "die-land": {
          "0%": {
            transform: "translateY(-14px) rotateX(-48deg) rotateY(28deg) scale(1.12)",
            opacity: "0",
          },
          "35%": { opacity: "1" },
          "62%": { transform: "translateY(2px) rotateX(10deg) rotateY(-7deg) scale(0.97)" },
          "100%": { transform: "translateY(0) rotateX(0deg) rotateY(0deg) scale(1)", opacity: "1" },
        },
      },
      animation: {
        "teaspoon-stir": "teaspoon-stir 0.6s ease-in-out infinite",
        "die-land": "die-land 0.85s cubic-bezier(0.34, 1.3, 0.5, 1) both",
      },
    },
  },
  plugins: [],
};

export default config;
