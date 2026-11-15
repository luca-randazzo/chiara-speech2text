# pip install matplotlib numpy

import json
import matplotlib.pyplot as plt
import numpy as np

def plot_training_metrics(json_file):
    """
    Reads a JSON file with training logs and plots the metrics.

    Args:
        json_file (str): The path to the JSON file.
    """
    with open(json_file, 'r') as f:
        data = json.load(f)

    log_history = data.get('log_history', [])
    if not log_history:
        print("No log history found in the JSON file.")
        return

    # Separate logs with and without 'eval_loss' for different plotting
    eval_logs = [log for log in log_history if 'eval_loss' in log]
    training_logs = [log for log in log_history if 'loss' in log and 'eval_loss' not in log]

    # Extract data for plotting
    eval_epochs = [log['epoch'] for log in eval_logs]
    eval_loss = [log['eval_loss'] for log in eval_logs]
    eval_wer = [log['eval_wer'] for log in eval_logs]

    training_epochs = [log['epoch'] for log in training_logs]
    training_loss = [log['loss'] for log in training_logs]
    learning_rate = [log['learning_rate'] for log in training_logs]
    grad_norm = [log.get('grad_norm') for log in training_logs] # Use .get() for optional keys

    # Determine the epoch range for xticks
    all_epochs = eval_epochs + training_epochs
    min_epoch = min(all_epochs) if all_epochs else 0
    max_epoch = max(all_epochs) if all_epochs else 1
    
    # Create plots
    fig, axs = plt.subplots(4, 1, figsize=(12, 24))
    fig.suptitle('Training Metrics vs. Epochs', fontsize=16)

    # Plot Eval Loss and Training Loss
    axs[0].plot(eval_epochs, eval_loss, 'o-', label='Evaluation Loss')
    axs[0].plot(training_epochs, training_loss, '.-', label='Training Loss', alpha=0.6)
    axs[0].set_xlabel('Epoch')
    axs[0].set_ylabel('Loss')
    axs[0].set_title('Loss vs. Epochs')
    axs[0].legend()
    axs[0].grid(True)
    axs[0].set_xticks(np.arange(min_epoch, max_epoch + 0.5, 0.5))

    # Plot Eval WER
    axs[1].plot(eval_epochs, eval_wer, 'o-', label='Evaluation WER')
    axs[1].set_xlabel('Epoch')
    axs[1].set_ylabel('Word Error Rate (WER)')
    axs[1].set_title('Evaluation WER vs. Epochs')
    axs[1].legend()
    axs[1].grid(True)
    axs[1].set_xticks(np.arange(min_epoch, max_epoch + 0.5, 0.5))

    # Plot Learning Rate
    axs[2].plot(training_epochs, learning_rate, '.-', label='Learning Rate')
    axs[2].set_xlabel('Epoch')
    axs[2].set_ylabel('Learning Rate')
    axs[2].set_title('Learning Rate vs. Epochs')
    axs[2].legend()
    axs[2].grid(True)
    axs[2].set_xticks(np.arange(min_epoch, max_epoch + 0.5, 0.5))

    # Plot Gradient Norm
    # Filter out None and inf values for plotting
    valid_grad_norms = [(epoch, norm) for epoch, norm in zip(training_epochs, grad_norm) if norm is not None and np.isfinite(norm)]
    if valid_grad_norms:
        grad_epochs, grad_norms = zip(*valid_grad_norms)
        axs[3].plot(grad_epochs, grad_norms, '.-', label='Gradient Norm', alpha=0.6)
        axs[3].set_xlabel('Epoch')
        axs[3].set_ylabel('Gradient Norm')
        axs[3].set_title('Gradient Norm vs. Epochs')
        axs[3].legend()
        axs[3].grid(True)
        axs[3].set_xticks(np.arange(min_epoch, max_epoch + 0.5, 0.5))
    else:
        axs[3].text(0.5, 0.5, 'No valid gradient norm data to plot.', ha='center', va='center')


    plt.tight_layout(rect=[0, 0.03, 1, 0.97])
    
    # Save the plot
    output_filename = 'training_plots.png'
    plt.savefig(output_filename)
    print(f"Plot saved to {output_filename}")

    # Show the plot only if in an interactive environment
    if 'agg' not in plt.get_backend().lower():
        plt.show()
    else:
        print("Running in a non-interactive environment. Plot will not be displayed.")

if __name__ == '__main__':
    # The JSON file is expected to be in the same directory as the script,
    # or a path can be provided as a command-line argument.
    import sys
    if len(sys.argv) > 1:
        json_file_path = sys.argv[1]
    else:
        json_file_path = '/home/luca/Development/chiara-speech2text/model-server/assets/trainer_state.json'
    
    plot_training_metrics(json_file_path)