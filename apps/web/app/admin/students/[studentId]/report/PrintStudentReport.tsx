'use client';

import { Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function PrintStudentReport() {
  return <Button type='button' onClick={() => window.print()}><Printer aria-hidden='true' />طباعة التقرير</Button>;
}
