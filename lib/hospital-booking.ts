import { getEnv } from "./runtime-env";

export const DEFAULT_HOSPITAL_BOOKING_PHONE = "+19297374257";

export function hospitalBookingPhone(): string {
  return getEnv("HOSPITAL_BOOKING_PHONE") ?? DEFAULT_HOSPITAL_BOOKING_PHONE;
}
