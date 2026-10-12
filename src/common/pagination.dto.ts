import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class PaginationDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize: number = 25;

  get skip() {
    return (this.page - 1) * this.pageSize;
  }
}

export function paginated<T>(items: T[], total: number, q: PaginationDto) {
  return { items, total, page: q.page, pageSize: q.pageSize };
}
