import type { Config } from "tailwindcss";
import plugin from "tailwindcss/plugin";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        aura: {
          bg: "#FFF7EC",
          // `warm` is decorative only (focus ring, shutter, fills) — on white it is
          // ~2.2:1, which fails the MIIT elderly-design rule (>=4.5:1, >=3:1 for
          // text >=18dp). Any *text* in the warm hue must use `ink` instead.
          warm: "#F4A259",
          ink: "#8A4B12", // same hue, 6.6:1 on white — the accessible text variant
          deep: "#7A4A2B",
          accent: "#2E7D6B",
          danger: "#C0392B",
        },
      },
      fontSize: {
        // elderly-first defaults; body copy starts at 24px
        base: ["1.5rem", { lineHeight: "2.1rem" }],
      },
    },
  },
  plugins: [plugin(({ addVariant }) => addVariant("hc", ".hc &"))],
};

export default config;