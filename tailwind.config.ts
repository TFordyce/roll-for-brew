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
    },
  },
  plugins: [],
};

export default config;
