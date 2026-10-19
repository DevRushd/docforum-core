import { z } from 'zod';

export const setVerificationStatusSchema = z.object({
  status: z.enum(['pending', 'verified', 'rejected']),
});

export const updateDoctorProfileSchema = z.object({
  fullName: z.string().trim().min(1).max(200),
}).strict();
