variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "ap-northeast-1"
}

variable "project_name" {
  description = "Project name"
  type        = string
  default     = "mvt-generator"
}

variable "bucket_name" {
  description = "S3 bucket name"
  type        = string
}

variable "allowed_origins" {
  description = "フロントエンドのオリジン（API と S3 アップロードの CORS で許可する）"
  type        = list(string)
  default     = ["http://localhost:5173"]
}
