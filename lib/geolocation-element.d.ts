// Chrome 144+'s <geolocation> element (used in app/components/EntryGate.tsx).
// Not in TypeScript's DOM types yet, so declare the bits Pulse uses.
import type { DetailedHTMLProps, HTMLAttributes } from "react";

declare global {
  interface HTMLGeolocationElement extends HTMLElement {
    readonly position: GeolocationPosition | null;
    readonly error: GeolocationPositionError | null;
  }
}

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      geolocation: DetailedHTMLProps<HTMLAttributes<HTMLGeolocationElement>, HTMLGeolocationElement>;
    }
  }
}
