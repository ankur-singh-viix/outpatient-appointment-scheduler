import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { Patient } from './patient.entity.js';
import { User } from './user.entity.js';

export const MEDICAL_REPORT_CATEGORIES = [
  'BLOOD_TESTS',
  'X_RAY',
  'CT_SCAN',
  'MRI',
  'ULTRASOUND',
  'ECG_CARDIAC',
  'OTHER',
] as const;

export type MedicalReportCategory = (typeof MEDICAL_REPORT_CATEGORIES)[number];
export type MedicalReportUploaderRole = 'PATIENT' | 'RECEPTIONIST';

@Entity({ name: 'patient_medical_reports' })
export class PatientMedicalReport {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'patient_id', type: 'uuid' })
  patientId!: string;

  @ManyToOne(() => Patient, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'patient_id' })
  patient!: Patient;

  @Column({ name: 'patient_uhid', type: 'varchar', length: 32 })
  patientUhid!: string;

  /** Matches DB enum medical_report_category from migration 019. */
  @Column({ type: 'enum', enum: [...MEDICAL_REPORT_CATEGORIES], enumName: 'medical_report_category' })
  category!: MedicalReportCategory;

  @Column({ name: 'report_date', type: 'date' })
  reportDate!: string;

  @Column({ name: 'original_filename', type: 'varchar', length: 255 })
  originalFilename!: string;

  @Column({ name: 'content_type', type: 'varchar', length: 100 })
  contentType!: string;

  @Column({ name: 'byte_size', type: 'int' })
  byteSize!: number;

  @Column({ name: 'storage_key', type: 'varchar', length: 512 })
  storageKey!: string;

  @Column({ name: 'uploaded_by_user_id', type: 'uuid' })
  uploadedByUserId!: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'uploaded_by_user_id' })
  uploadedBy!: User;

  /** Matches DB enum medical_report_uploader_role from migration 019. */
  @Column({
    name: 'uploaded_by_role',
    type: 'enum',
    enum: ['PATIENT', 'RECEPTIONIST'],
    enumName: 'medical_report_uploader_role',
  })
  uploadedByRole!: MedicalReportUploaderRole;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
