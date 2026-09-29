import type { FanSpeedType } from 'lutron-leap'

// Confirmed against a live bridge (Floor Fan, Bathroom Fan): zone status for a
// CasetaFanSpeedController has a FanSpeed field only -- no Level -- with exactly
// these 5 values.
export const FAN_SPEED_CHOICES: FanSpeedType[] = ['Off', 'Low', 'Medium', 'MediumHigh', 'High']

// Lutron's LEAP API never reports a numeric fan speed -- FanSpeed is always one of
// the 5 names above. This mapping is our own assumption (an even 25% step per
// speed), not something confirmed from Lutron documentation or the API itself.
export const FAN_SPEED_PERCENT: Record<FanSpeedType, number> = {
	Off: 0,
	Low: 25,
	Medium: 50,
	MediumHigh: 75,
	High: 100,
}
