# =============================================================================
# Input Variables
# =============================================================================

variable "aws_region" {
  description = "AWS region to deploy into"
  type        = string
  default     = "us-east-1"
}

variable "project_name" {
  description = "Project name used for resource naming"
  type        = string
  default     = "veradigm"
}

variable "environment" {
  description = "Deployment environment (sandbox / production)"
  type        = string
  default     = "sandbox"
}

# --- VPC ---
variable "vpc_cidr" {
  description = "CIDR block for the VPC"
  type        = string
  default     = "10.0.0.0/16"
}

# --- EC2 ---
variable "ec2_instance_type" {
  description = "EC2 instance type"
  type        = string
  default     = "t3.small"
}

variable "ec2_key_pair_name" {
  description = "Name of an existing EC2 key pair for SSH access (optional, SSM preferred)"
  type        = string
  default     = ""
}

# --- ALB / SSL ---
variable "domain_name" {
  description = "Custom domain name for ALB (e.g. mcp.example.com). Leave empty to skip SSL."
  type        = string
  default     = ""
}

variable "certificate_arn" {
  description = "ACM certificate ARN for HTTPS. Required if domain_name is set."
  type        = string
  default     = ""
}

# --- GitHub OIDC ---
variable "github_org" {
  description = "GitHub organisation or username (e.g. your-org)"
  type        = string
}

variable "github_repos" {
  description = "List of GitHub repo names allowed to assume the deploy role"
  type        = list(string)
  default     = ["veradigm-ai-mcp", "veradigmai"]
}
