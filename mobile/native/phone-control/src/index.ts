import { registerPlugin } from "@capacitor/core";
import type { PiPhoneControlPlugin } from "./definitions";

export type * from "./definitions";

export const PiPhoneControl = registerPlugin<PiPhoneControlPlugin>("PiPhoneControl");
