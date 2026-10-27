import { Column, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';

@Entity('specialties')
@Unique('uq_specialties_name', ['name'])
export class Specialty {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 120 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;
}
