<?php

namespace App\Mail;

use Illuminate\Bus\Queueable;
use Illuminate\Mail\Mailable;
use Illuminate\Queue\SerializesModels;

class CenterInvitationMail extends Mailable
{
    use Queueable, SerializesModels;

    public function __construct(public string $centerName, public string $acceptUrl) {}

    public function build(): self
    {
        return $this->subject('Center invitation')
            ->text('emails.center-invitation');
    }
}
