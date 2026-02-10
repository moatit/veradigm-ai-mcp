# =============================================================================
# Outputs
# =============================================================================

output "vpc_id" {
  description = "VPC ID"
  value       = aws_vpc.main.id
}

output "ec2_instance_id" {
  description = "EC2 instance ID (needed for GitHub Actions SSM deploy)"
  value       = aws_instance.app.id
}

output "ec2_public_ip" {
  description = "EC2 Elastic IP"
  value       = aws_eip.app.public_ip
}

output "alb_dns_name" {
  description = "ALB DNS name — point your domain CNAME here"
  value       = aws_lb.main.dns_name
}

output "ecr_repository_urls" {
  description = "ECR repository URLs for Docker push"
  value = {
    for name, repo in aws_ecr_repository.repos : name => repo.repository_url
  }
}

output "github_actions_role_arn" {
  description = "IAM Role ARN for GitHub Actions OIDC"
  value       = aws_iam_role.github_actions.arn
}

